'use strict';

const { Provider } = require('./provider.model');
const { ProviderProduct } = require('./providerProduct.model');
const { getProviderAdapter } = require('./adapters/adapter.factory');
const crypto = require('crypto');
const { TARGET_UID_RE } = require('./adapters/xena.adapter');
const { AppError, BusinessRuleError, NotFoundError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    ADMIN_ACTIONS,
    PROVIDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const {
    XENA_PROVIDER_SLUG,
    XENA_DYNAMIC_PRODUCT_ID,
    XENA_DYNAMIC_PRODUCT_NAME,
    XENA_TARGET_FIELD_KEY,
    XENA_TARGET_FIELD_PROVIDER_KEY,
    XENA_CONNECTION_STATUS,
} = require('./xena.constants');
const { Decimal, PRICE_DP, toStr } = require('../../shared/utils/decimalPrecision');

const createXenaAuditLog = (params) => {
    if (!params.actorId) return;
    createAuditLog(params);
};

const asOperationalXenaError = (err) => {
    if (err?.isOperational) return err;
    if (err?.name === 'XenaApiError' || String(err?.code || '').startsWith('XENA_')) {
        return new AppError(
            err.message || 'Xena provider request failed.',
            err.statusCode || 502,
            err.code || 'XENA_PROVIDER_ERROR'
        );
    }
    return err;
};

const maskTargetUid = (uid) => {
    const value = String(uid ?? '');
    if (value.length <= 4) return '*'.repeat(value.length);
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
};

const assertTargetUid = (targetUid) => {
    if (typeof targetUid !== 'string') {
        throw new BusinessRuleError('Xena ID must contain digits only and be at most 50 characters.', 'INVALID_XENA_TARGET_UID');
    }
    const uid = targetUid.trim();
    if (!uid || !TARGET_UID_RE.test(uid) || uid.length > 50) {
        throw new BusinessRuleError('Xena ID must contain digits only and be at most 50 characters.', 'INVALID_XENA_TARGET_UID');
    }
    return uid;
};

const hashTargetUid = (uid) => crypto
    .createHash('sha256')
    .update(String(uid))
    .digest('hex')
    .slice(0, 12);

const logXenaTargetDiagnostic = ({ provider, uid, error, outcome }) => {
    if (!['development', 'test'].includes(process.env.NODE_ENV)) return;
    console.warn('[XenaTargetVerification]', {
        operation: 'verify_target_user',
        providerId: provider?._id ? String(provider._id) : null,
        upstreamStatus: error?.statusCode ?? null,
        upstreamCode: error?.code ?? null,
        requestId: error?.requestId ?? null,
        targetUidHash: uid ? hashTargetUid(uid) : null,
        outcome,
    });
};

const isXenaProvider = (provider) => (
    String(provider?.slug || provider?.name || '').toLowerCase().trim() === XENA_PROVIDER_SLUG
    || String(provider?.name || '').toLowerCase().trim() === 'xena recharge'
);

const assertXenaProvider = async (providerId, { requireActive = false } = {}) => {
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');
    if (!isXenaProvider(provider)) {
        throw new BusinessRuleError('Provider is not Xena Recharge.', 'NOT_XENA_PROVIDER');
    }
    if (requireActive && !provider.isActive) {
        throw new BusinessRuleError('Provider is inactive.', 'PROVIDER_INACTIVE');
    }
    return provider;
};

const getXenaAdapter = (provider) => getProviderAdapter(provider, { strict: true });

const normalizeConnectionStatus = (status, fallback = XENA_CONNECTION_STATUS.PENDING) => {
    const normalized = String(status || '').trim().toLowerCase();
    return Object.values(XENA_CONNECTION_STATUS).includes(normalized) ? normalized : fallback;
};

const toIsoOrNull = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const sanitizeXenaConnectionSnapshot = (connection = {}) => {
    const connectionExpiresAt = toIsoOrNull(connection.connectionExpiresAt || connection.expiresAt);
    const tokenExpiresAt = toIsoOrNull(connection.tokenExpiresAt);
    const lastCheckedAt = toIsoOrNull(connection.lastCheckedAt);
    const expired = Boolean(connectionExpiresAt && new Date(connectionExpiresAt).getTime() <= Date.now());
    const status = normalizeConnectionStatus(connection.connectionStatus || connection.status);

    return {
        connectionStatus: status,
        status,
        displayName: connection.displayName ?? null,
        maskedUsername: connection.maskedUsername ?? null,
        connectionExpiresAt,
        tokenExpiresAt,
        lastErrorCode: connection.lastErrorCode ?? null,
        lastErrorMessage: connection.lastErrorMessage ?? null,
        lastCheckedAt,
        connectionExpired: expired,
        needsReauthentication: expired || status === XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED,
    };
};

const applySafeConnectionSnapshot = (provider, connection) => {
    provider.xenaConfig = provider.xenaConfig || {};
    provider.xenaConfig.connectionId = connection.connectionId ?? provider.xenaConfig.connectionId ?? null;
    provider.xenaConfig.connectionStatus = normalizeConnectionStatus(
        connection.status ?? connection.connectionStatus,
        provider.xenaConfig.connectionStatus ?? XENA_CONNECTION_STATUS.PENDING
    );
    provider.xenaConfig.connectionExpiresAt = connection.expiresAt || connection.connectionExpiresAt
        ? new Date(connection.expiresAt || connection.connectionExpiresAt)
        : provider.xenaConfig.connectionExpiresAt ?? null;
    provider.xenaConfig.tokenExpiresAt = connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt) : provider.xenaConfig.tokenExpiresAt ?? null;
    provider.xenaConfig.displayName = connection.displayName ?? provider.xenaConfig.displayName ?? null;
    provider.xenaConfig.maskedUsername = connection.maskedUsername ?? provider.xenaConfig.maskedUsername ?? null;
    provider.xenaConfig.lastErrorCode = connection.lastErrorCode ?? null;
    provider.xenaConfig.lastErrorMessage = connection.lastErrorMessage ?? null;
    provider.xenaConfig.lastCheckedAt = new Date();
};

const challengeConnection = async (providerId, { displayName, username, password }, auditContext = {}) => {
    if (!displayName || !username || !password) {
        throw new BusinessRuleError('displayName, username, and password are required.', 'INVALID_XENA_CHALLENGE');
    }
    const provider = await assertXenaProvider(providerId, { requireActive: true });
    const adapter = getXenaAdapter(provider);
    let result;
    try {
        result = await adapter.challengeConnection({
            connectionId: provider.xenaConfig?.connectionId ?? null,
            displayName: String(displayName).trim(),
            username: String(username).trim(),
            password,
        });
    } catch (err) {
        throw asOperationalXenaError(err);
    }

    provider.xenaConfig = provider.xenaConfig || {};
    applySafeConnectionSnapshot(provider, {
        connectionId: result.connectionId,
        status: result.status || XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED,
        expiresAt: result.expiresAt,
        displayName: String(displayName).trim(),
        lastErrorCode: null,
        lastErrorMessage: null,
    });
    await provider.save();

    createXenaAuditLog({
        actorId: auditContext.actorId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: {
            event: 'XENA_CHALLENGE_REQUESTED',
            providerId: provider._id,
            status: result.status,
            requestId: result.requestId,
        },
    });

    return {
        ...sanitizeXenaConnectionSnapshot(provider.xenaConfig),
        requestId: result.requestId,
    };
};

const verifyConnection = async (providerId, { code }, auditContext = {}) => {
    if (!code) throw new BusinessRuleError('Verification code is required.', 'MISSING_XENA_VERIFICATION_CODE');
    const provider = await assertXenaProvider(providerId, { requireActive: true });
    const connectionId = provider.xenaConfig?.connectionId;
    if (!connectionId) throw new BusinessRuleError('No Xena connection challenge is pending.', 'XENA_CONNECTION_REQUIRED');

    const adapter = getXenaAdapter(provider);
    let result;
    try {
        result = await adapter.verifyConnection({ connectionId, code: String(code).trim() });
    } catch (err) {
        throw asOperationalXenaError(err);
    }
    provider.xenaConfig.connectionStatus = normalizeConnectionStatus(result.status, XENA_CONNECTION_STATUS.CONNECTED);
    provider.xenaConfig.lastCheckedAt = new Date();
    provider.xenaConfig.lastErrorCode = null;
    provider.xenaConfig.lastErrorMessage = null;
    await provider.save();

    createXenaAuditLog({
        actorId: auditContext.actorId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: {
            event: 'XENA_VERIFICATION_COMPLETED',
            providerId: provider._id,
            status: result.status,
            requestId: result.requestId,
        },
    });

    return {
        ...sanitizeXenaConnectionSnapshot(provider.xenaConfig),
        requestId: result.requestId,
    };
};

const refreshConnection = async (providerId, auditContext = {}) => {
    const provider = await assertXenaProvider(providerId);
    const adapter = getXenaAdapter(provider);
    let connection;
    try {
        connection = await adapter.getConnection();
    } catch (err) {
        throw asOperationalXenaError(err);
    }
    applySafeConnectionSnapshot(provider, connection);
    await provider.save();

    createXenaAuditLog({
        actorId: auditContext.actorId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: {
            event: 'XENA_CONNECTION_CHECKED',
            providerId: provider._id,
            status: connection.status,
        },
    });

    return sanitizeXenaConnectionSnapshot(provider.xenaConfig);
};

const updateProductConfig = async (providerId, productConfig, auditContext = {}) => {
    const provider = await assertXenaProvider(providerId);
    let unitPrice;
    try {
        unitPrice = new Decimal(productConfig.unitPrice);
    } catch {
        throw new BusinessRuleError('unitPrice must be a finite decimal greater than zero.', 'INVALID_XENA_UNIT_PRICE');
    }
    const minAmount = Number(productConfig.minAmount);
    const maxAmount = Number(productConfig.maxAmount);
    const isActive = Boolean(productConfig.isActive);

    if (!unitPrice.isFinite() || !unitPrice.gt(0) || unitPrice.decimalPlaces() > PRICE_DP) {
        throw new BusinessRuleError(`unitPrice must be a finite decimal greater than zero with at most ${PRICE_DP} decimal places.`, 'INVALID_XENA_UNIT_PRICE');
    }
    if (!Number.isSafeInteger(minAmount) || minAmount <= 0) {
        throw new BusinessRuleError('minAmount must be a positive safe integer.', 'INVALID_XENA_MIN_AMOUNT');
    }
    if (!Number.isSafeInteger(maxAmount) || maxAmount <= 0 || maxAmount < minAmount) {
        throw new BusinessRuleError('maxAmount must be a positive safe integer >= minAmount.', 'INVALID_XENA_MAX_AMOUNT');
    }

    provider.xenaConfig = provider.xenaConfig || {};
    provider.xenaConfig.product = {
        externalProductId: productConfig.externalProductId || XENA_DYNAMIC_PRODUCT_ID,
        name: productConfig.name || XENA_DYNAMIC_PRODUCT_NAME,
        unitPrice: toStr(unitPrice),
        minAmount,
        maxAmount,
        isActive,
    };
    await provider.save();

    createXenaAuditLog({
        actorId: auditContext.actorId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: {
            event: 'XENA_PRODUCT_CONFIG_UPDATED',
            providerId: provider._id,
            externalProductId: provider.xenaConfig.product.externalProductId,
            unitPrice: toStr(unitPrice),
            minAmount,
            maxAmount,
            isActive,
        },
    });

    return provider.xenaConfig.product;
};

const ensureConnectedForFulfillment = (provider) => {
    const status = provider?.xenaConfig?.connectionStatus;
    if (status !== XENA_CONNECTION_STATUS.CONNECTED) {
        throw new BusinessRuleError('Xena connection is not connected.', 'XENA_CONNECTION_NOT_READY');
    }
};

const markXenaReauthenticationRequired = async (provider, err = {}) => {
    if (!provider) return;
    provider.xenaConfig = provider.xenaConfig || {};
    provider.xenaConfig.connectionStatus = XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED;
    provider.xenaConfig.lastErrorCode = err.code ?? 'XENA_REAUTHENTICATION_REQUIRED';
    provider.xenaConfig.lastErrorMessage = 'Xena connection requires login again.';
    provider.xenaConfig.lastCheckedAt = new Date();
    await provider.save();
};

const isTargetInvalidError = (err) => {
    const status = Number(err?.statusCode);
    const code = String(err?.code || '').trim().toUpperCase();
    const message = String(err?.message || '').trim().toUpperCase();
    if (status === 404) return true;
    if (['INVALID_TARGET_UID', 'TARGET_INVALID', 'XENA_TARGET_INVALID', 'TARGET_NOT_FOUND', 'USER_NOT_FOUND', 'XENA_USER_NOT_FOUND'].includes(code)) {
        return true;
    }
    if (status === 400 && /(TARGET|USER).*(INVALID|NOT_FOUND|NOT FOUND)|INVALID.*(TARGET|USER)/.test(`${code} ${message}`)) {
        return true;
    }
    return false;
};

const isReauthenticationError = (err) => {
    const status = Number(err?.statusCode);
    const code = String(err?.code || '').trim().toUpperCase();
    const message = String(err?.message || '').trim().toUpperCase();
    const combined = `${code} ${message}`;
    if (['XENA_CONNECTION_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'XENA_REAUTHENTICATION_REQUIRED'].includes(code)) return true;
    if (status === 409 && /(REAUTH|SESSION|CONNECTION|EXPIRED|DISCONNECTED|LOGIN)/.test(combined)) return true;
    if (/(REAUTHENTICATION_REQUIRED|SESSION_EXPIRED|CONNECTION_EXPIRED|INVALID_CONNECTION|DISCONNECTED|LOGIN_REQUIRED)/.test(combined)) return true;
    return false;
};

const mapXenaTargetVerificationError = async (err, { provider, uid } = {}) => {
    if (err?.isOperational && !String(err.code || '').startsWith('XENA_')) return err;

    if (isTargetInvalidError(err)) {
        logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'target_invalid' });
        return new AppError('Xena ID is not valid.', 404, 'XENA_TARGET_INVALID');
    }

    if (isReauthenticationError(err)) {
        await markXenaReauthenticationRequired(provider, err);
        logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'reauthentication_required' });
        return new AppError('Xena connection requires login again.', 409, 'XENA_REAUTHENTICATION_REQUIRED');
    }

    const status = Number(err?.statusCode);
    const code = String(err?.code || '').trim().toUpperCase();
    const message = String(err?.message || '').trim().toUpperCase();
    if (/(CLIENT API KEY|API KEY|API TOKEN|TOKEN).*(REQUIRED|MISSING|INVALID)|AUTHORIZATION|UNAUTHORIZED/.test(message)) {
        logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'provider_auth_failed' });
        return new AppError('Xena provider authentication failed.', 502, 'XENA_PROVIDER_AUTH_FAILED');
    }
    if (status === 401 || status === 403) {
        logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'provider_auth_failed' });
        return new AppError('Xena provider authentication failed.', 502, 'XENA_PROVIDER_AUTH_FAILED');
    }

    if (status === 429 || code === 'XENA_RATE_LIMIT' || code === 'RATE_LIMITED') {
        logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'rate_limited' });
        return new AppError('Xena verification is temporarily busy. Please try again shortly.', 429, 'XENA_RATE_LIMITED');
    }

    logXenaTargetDiagnostic({ provider, uid, error: err, outcome: 'verification_unavailable' });
    return new AppError('Xena verification is temporarily unavailable.', 503, 'XENA_VERIFICATION_UNAVAILABLE');
};

const verifyTargetForProduct = async ({ product, provider, targetUid, auditContext = {} }) => {
    const uid = assertTargetUid(targetUid);
    if (provider?.xenaConfig?.connectionStatus !== XENA_CONNECTION_STATUS.CONNECTED || !provider?.xenaConfig?.connectionId) {
        if (!provider?.xenaConfig?.connectionId || provider?.xenaConfig?.connectionStatus === XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED) {
            await markXenaReauthenticationRequired(provider, { code: 'XENA_CONNECTION_REQUIRED' });
        }
        throw new AppError('Xena connection requires login again.', 409, 'XENA_REAUTHENTICATION_REQUIRED');
    }

    let result;
    try {
        const adapter = getXenaAdapter(provider);
        result = await adapter.verifyTargetUser({ targetUid: uid });
    } catch (err) {
        throw await mapXenaTargetVerificationError(err, { provider, uid });
    }

    createXenaAuditLog({
        actorId: auditContext.actorId,
        actorRole: auditContext.actorRole || ACTOR_ROLES.CUSTOMER,
        action: PROVIDER_ACTIONS.STATUS_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: {
            event: 'XENA_TARGET_VERIFICATION',
            productId: product?._id ?? null,
            providerId: provider._id,
            targetUid: maskTargetUid(uid),
            valid: result.valid === true,
        },
    });

    if (result.valid !== true) {
        throw new AppError('Xena ID is not valid.', 404, 'XENA_TARGET_INVALID');
    }

    return {
        valid: true,
        targetUid: uid,
        user: {
            uid: result.uid,
            nickname: result.nickname,
            avatar: result.avatar,
            country: result.country,
        },
        uid: result.uid,
        nickname: result.nickname,
        avatar: result.avatar,
        country: result.country,
    };
};

const isXenaProviderProduct = async (providerProductId) => {
    if (!providerProductId) return false;
    const pp = await ProviderProduct.findById(providerProductId).select('externalProductId').lean();
    return pp?.externalProductId === XENA_DYNAMIC_PRODUCT_ID;
};

const getCanonicalOrderField = () => ({
    id: XENA_TARGET_FIELD_KEY,
    key: XENA_TARGET_FIELD_KEY,
    label: 'Xena ID',
    type: 'text',
    required: true,
    verifiable: true,
    isActive: true,
    sortOrder: 0,
});

const mergeXenaProductBehavior = (productLike) => {
    const existingFields = Array.isArray(productLike.orderFields) ? productLike.orderFields : [];
    const hasField = existingFields.some((field) => field?.key === XENA_TARGET_FIELD_KEY);
    productLike.orderFields = hasField
        ? existingFields.map((field) => (
            field?.key === XENA_TARGET_FIELD_KEY
                ? { ...field, required: true, verifiable: true, isActive: field.isActive !== false }
                : field
        ))
        : [...existingFields, getCanonicalOrderField()];

    const currentMapping = productLike.providerMapping instanceof Map
        ? Object.fromEntries(productLike.providerMapping.entries())
        : { ...(productLike.providerMapping || {}) };
    currentMapping[XENA_TARGET_FIELD_KEY] = XENA_TARGET_FIELD_PROVIDER_KEY;
    productLike.providerMapping = currentMapping;
    return productLike;
};

module.exports = {
    assertTargetUid,
    maskTargetUid,
    isXenaProvider,
    assertXenaProvider,
    challengeConnection,
    verifyConnection,
    refreshConnection,
    updateProductConfig,
    ensureConnectedForFulfillment,
    verifyTargetForProduct,
    isXenaProviderProduct,
    mergeXenaProductBehavior,
    getCanonicalOrderField,
    sanitizeXenaConnectionSnapshot,
    normalizeConnectionStatus,
};

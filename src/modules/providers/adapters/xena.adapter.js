'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { BaseProviderAdapter } = require('./base.adapter');
const {
    XENA_BASE_URL,
    XENA_DYNAMIC_PRODUCT_ID,
    XENA_DYNAMIC_PRODUCT_NAME,
    XENA_CONNECTION_STATUS,
    XENA_RECHARGE_STATUS,
} = require('../xena.constants');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.XENA_API_TIMEOUT_MS ?? '20000', 10);
const DEFAULT_STATUS_CONCURRENCY = parseInt(process.env.XENA_STATUS_CHECK_CONCURRENCY ?? '3', 10);
const TARGET_UID_RE = /^\d+$/;

const isPositiveSafeInteger = (value) => (
    Number.isSafeInteger(Number(value))
    && Number(value) > 0
    && String(Number(value)) === String(value).trim()
);

const sanitizeErrorBody = (body) => {
    const upstream = body?.error ?? body ?? {};
    return {
        code: upstream.code ?? body?.code ?? null,
        message: upstream.message ?? body?.message ?? null,
        requestId: upstream.requestId ?? body?.requestId ?? null,
    };
};

class XenaApiError extends Error {
    constructor(message, { statusCode = null, code = null, requestId = null, retryable = false, uncertain = false } = {}) {
        super(message);
        this.name = 'XenaApiError';
        this.statusCode = statusCode;
        this.code = code;
        this.requestId = requestId;
        this.retryable = retryable;
        this.uncertain = uncertain;
    }
}

const mapRechargeStatus = (status) => {
    switch (String(status ?? '').toLowerCase()) {
        case XENA_RECHARGE_STATUS.SUCCEEDED:
            return { providerStatus: 'Completed', outcomeUncertain: false };
        case XENA_RECHARGE_STATUS.FAILED:
            return { providerStatus: 'Failed', outcomeUncertain: false };
        case XENA_RECHARGE_STATUS.UNKNOWN:
            return { providerStatus: 'Unknown', outcomeUncertain: true };
        case XENA_RECHARGE_STATUS.PROCESSING:
        default:
            return { providerStatus: 'Pending', outcomeUncertain: false };
    }
};

const buildClient = (baseURL, token, timeoutMs) => {
    const client = axios.create({
        baseURL: baseURL || XENA_BASE_URL,
        timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const statusCode = err.response?.status ?? null;
            const safeBody = sanitizeErrorBody(err.response?.data);
            const code = safeBody.code || err.code || 'XENA_REQUEST_FAILED';
            const retryable = statusCode === 429 || statusCode >= 500
                || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code);
            const uncertain = err.code === 'ECONNABORTED'
                || err.code === 'ETIMEDOUT'
                || statusCode === 429
                || statusCode === 502
                || statusCode === 503
                || statusCode === 504;

            return Promise.reject(new XenaApiError(
                `[Xena] HTTP ${statusCode ?? 'NETWORK'}: ${code}`,
                {
                    statusCode,
                    code,
                    requestId: safeBody.requestId,
                    retryable,
                    uncertain,
                }
            ));
        }
    );

    return client;
};

class XenaRechargeAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[Xena] provider.baseUrl is required');
        if (!token) throw new Error('[Xena] client API key is required');

        this._client = options.client || buildClient(provider.baseUrl, token, options.timeoutMs);
        this._statusConcurrency = Math.max(1, parseInt(options.statusConcurrency ?? DEFAULT_STATUS_CONCURRENCY, 10));
    }

    get _configProduct() {
        return this.provider.xenaConfig?.product ?? {};
    }

    _hasCompleteProductConfig() {
        const p = this._configProduct;
        return p.isActive === true
            && p.unitPrice != null
            && Number(p.unitPrice) > 0
            && Number.isSafeInteger(Number(p.minAmount))
            && Number.isSafeInteger(Number(p.maxAmount))
            && Number(p.minAmount) > 0
            && Number(p.maxAmount) >= Number(p.minAmount);
    }

    async getProducts() {
        const p = this._configProduct;
        const configured = this._hasCompleteProductConfig();

        return [
            this._validateDTO({
                externalProductId: p.externalProductId || XENA_DYNAMIC_PRODUCT_ID,
                rawName: p.name || XENA_DYNAMIC_PRODUCT_NAME,
                rawPrice: configured ? String(p.unitPrice) : '0',
                minQty: configured ? Number(p.minAmount) : 1,
                maxQty: configured ? Number(p.maxAmount) : 1,
                isActive: configured,
                rawPayload: {
                    type: 'dynamic_recharge',
                    source: 'provider_configuration',
                    amountMode: 'quantity',
                    configurationComplete: configured,
                },
            }),
        ];
    }

    async testConnection() {
        const status = await this.getConnection();
        return {
            success: status.status === XENA_CONNECTION_STATUS.CONNECTED,
            status: status.status,
            checkedAt: new Date().toISOString(),
        };
    }

    async challengeConnection({ connectionId = null, displayName, username, password }) {
        const body = {
            displayName,
            username,
            password,
        };
        if (connectionId) body.connectionId = connectionId;

        const { data } = await this._client.post('/v1/connections/challenge', body);
        return {
            connectionId: data?.data?.connectionId,
            status: data?.data?.status,
            expiresAt: data?.data?.expiresAt ?? null,
            requestId: data?.requestId ?? null,
        };
    }

    async verifyConnection({ connectionId, code }) {
        const { data } = await this._client.post('/v1/connections/verify', { connectionId, code });
        return {
            connectionId: data?.data?.connectionId,
            status: data?.data?.status,
            requestId: data?.requestId ?? null,
        };
    }

    async getConnection(connectionId = null) {
        const resolvedConnectionId = connectionId || this.provider.xenaConfig?.connectionId;
        if (!resolvedConnectionId) throw new XenaApiError('Missing Xena connectionId', { code: 'XENA_CONNECTION_REQUIRED' });
        const { data } = await this._client.get(`/v1/connections/${encodeURIComponent(resolvedConnectionId)}`);
        return {
            connectionId: data.connectionId,
            displayName: data.displayName ?? null,
            maskedUsername: data.username ?? null,
            status: data.status,
            tokenExpiresAt: data.tokenExpiresAt ?? null,
            lastErrorCode: data.lastErrorCode ?? null,
            lastErrorMessage: data.lastErrorMessage ?? null,
            createdAt: data.createdAt ?? null,
            updatedAt: data.updatedAt ?? null,
        };
    }

    async verifyTargetUser({ connectionId = null, targetUid }) {
        const resolvedConnectionId = connectionId || this.provider.xenaConfig?.connectionId;
        const uid = String(targetUid ?? '').trim();
        if (!resolvedConnectionId) throw new XenaApiError('Missing Xena connectionId', { code: 'XENA_CONNECTION_REQUIRED' });
        if (!TARGET_UID_RE.test(uid) || uid.length > 50) {
            throw new XenaApiError('Invalid Xena target UID', { statusCode: 400, code: 'INVALID_TARGET_UID' });
        }

        const { data } = await this._client.get(
            `/v1/connections/${encodeURIComponent(resolvedConnectionId)}/users/${encodeURIComponent(uid)}`
        );
        return {
            uid: String(data.uid ?? uid),
            nickname: data.nickname ?? null,
            avatar: data.avatar ?? null,
            country: data.country ?? null,
            valid: data.valid === true,
        };
    }

    async getBalance(connectionId = null) {
        const resolvedConnectionId = connectionId || this.provider.xenaConfig?.connectionId;
        if (!resolvedConnectionId) throw new XenaApiError('Missing Xena connectionId', { code: 'XENA_CONNECTION_REQUIRED' });
        const { data } = await this._client.get(`/v1/connections/${encodeURIComponent(resolvedConnectionId)}/balance`);
        return {
            balance: data?.data?.balance ?? null,
            source: 'xena_live',
            checkedAt: new Date().toISOString(),
            requestId: data?.requestId ?? null,
        };
    }

    _buildRechargeBody(params) {
        const connectionId = this.provider.xenaConfig?.connectionId;
        const targetUid = String(params.targetUid ?? params.target_uid ?? '').trim();
        const amount = Number(params.amount ?? params.quantity);
        const clientReference = String(params.clientReference ?? params.referenceId ?? params.orderId ?? '').slice(0, 100);

        if (!connectionId) throw new XenaApiError('Missing Xena connectionId', { code: 'XENA_CONNECTION_REQUIRED' });
        if (!TARGET_UID_RE.test(targetUid) || targetUid.length > 50) {
            throw new XenaApiError('Invalid Xena target UID', { statusCode: 400, code: 'INVALID_TARGET_UID' });
        }
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new XenaApiError('Invalid Xena amount', { statusCode: 400, code: 'INVALID_AMOUNT' });
        }
        if (!clientReference) {
            throw new XenaApiError('Missing Xena clientReference', { statusCode: 400, code: 'MISSING_CLIENT_REFERENCE' });
        }

        return { connectionId, targetUid, amount, clientReference };
    }

    _buildIdempotencyKey(params, body) {
        const supplied = params.idempotencyKey || params.providerIdempotencyKey;
        if (supplied) return String(supplied).slice(0, 150);
        const stableSeed = params.orderId || params.referenceId || body.clientReference;
        const digest = crypto.createHash('sha256')
            .update(JSON.stringify({ stableSeed, body }))
            .digest('hex')
            .slice(0, 32);
        return `xena-${digest}`;
    }

    async placeOrder(params) {
        let body;
        let idempotencyKey;
        try {
            body = this._buildRechargeBody(params);
            idempotencyKey = this._buildIdempotencyKey(params, body);
        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Failed',
                rawResponse: { code: err.code || 'XENA_LOCAL_VALIDATION_FAILED' },
                errorMessage: err.message,
            };
        }

        try {
            const { data } = await this._client.post('/v1/recharges', body, {
                headers: { 'Idempotency-Key': idempotencyKey },
            });
            const mapped = mapRechargeStatus(data.status);
            return {
                success: data.status !== XENA_RECHARGE_STATUS.FAILED,
                providerOrderId: data.id ?? null,
                providerStatus: mapped.providerStatus,
                rawResponse: {
                    id: data.id ?? null,
                    status: data.status,
                    errorCode: data.errorCode ?? null,
                    errorMessage: data.errorMessage ?? null,
                    providerMessage: data.providerMessage ?? null,
                    requestId: data.requestId ?? null,
                    idempotencyKey,
                    requestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
                    outcomeUncertain: mapped.outcomeUncertain,
                },
                errorMessage: data.errorMessage ?? null,
                outcomeUncertain: mapped.outcomeUncertain,
                retryable: data.status === XENA_RECHARGE_STATUS.PROCESSING || mapped.outcomeUncertain,
                requestId: data.requestId ?? null,
                errorCode: data.errorCode ?? null,
                requestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
            };
        } catch (err) {
            if (err.uncertain || err.retryable) {
                return {
                    success: true,
                    providerOrderId: null,
                    providerStatus: 'Pending',
                    rawResponse: {
                        code: err.code,
                        requestId: err.requestId ?? null,
                        retryable: err.retryable === true,
                        outcomeUncertain: err.uncertain === true,
                        idempotencyKey,
                        requestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
                    },
                    errorMessage: null,
                    outcomeUncertain: err.uncertain === true,
                    retryable: true,
                    requestId: err.requestId ?? null,
                    errorCode: err.code ?? null,
                    requestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
                };
            }

            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Failed',
                rawResponse: { code: err.code, requestId: err.requestId ?? null },
                errorMessage: err.message,
                requestId: err.requestId ?? null,
                errorCode: err.code ?? null,
            };
        }
    }

    async checkOrder(orderId) {
        const { data } = await this._client.get(`/v1/recharges/${encodeURIComponent(orderId)}`);
        const mapped = mapRechargeStatus(data.status);
        return {
            providerOrderId: data.id ?? orderId,
            providerStatus: mapped.providerStatus,
            rawResponse: {
                id: data.id ?? orderId,
                status: data.status,
                errorCode: data.errorCode ?? null,
                errorMessage: data.errorMessage ?? null,
                providerMessage: data.providerMessage ?? null,
                outcomeUncertain: mapped.outcomeUncertain,
            },
            outcomeUncertain: mapped.outcomeUncertain,
            errorCode: data.errorCode ?? null,
        };
    }

    async getOrderStatus(orderId) {
        return this.checkOrder(orderId);
    }

    async checkOrders(orderIds) {
        const ids = Array.isArray(orderIds) ? orderIds : [];
        const results = [];
        let index = 0;

        const worker = async () => {
            while (index < ids.length) {
                const current = index++;
                results[current] = await this.checkOrder(ids[current]);
            }
        };

        const workers = Array.from(
            { length: Math.min(this._statusConcurrency, ids.length) },
            () => worker()
        );
        await Promise.all(workers);
        return results;
    }
}

module.exports = {
    XenaRechargeAdapter,
    XenaApiError,
    TARGET_UID_RE,
    isPositiveSafeInteger,
    mapRechargeStatus,
};

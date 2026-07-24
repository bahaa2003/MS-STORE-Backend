'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, MAX_RETRY_COUNT, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { XenaRechargeAdapter, XenaApiError } = require('../modules/providers/adapters/xena.adapter');
const { getProviderAdapter, registerAdapter } = require('../modules/providers/adapters/adapter.factory');
const { executeOrder, processOrderStatusResult, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const xenaSvc = require('../modules/providers/xena.service');
const syncService = require('../modules/providers/sync.service');
const providerService = require('../modules/providers/provider.service');
const adminProvidersService = require('../modules/admin/admin.providers.service');
const { AuditLog } = require('../modules/audit/audit.model');
const { createOrder } = require('../modules/orders/order.service');
const { inspectXenaProcessingOrders } = require('../../scripts/reconciliation/fix-xena-processing-orders');
const { decryptCredential, isEncrypted } = require('../modules/providers/providerCredentialCrypto');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const app = require('../app');
const {
    XENA_PROVIDER_SLUG,
    XENA_DYNAMIC_PRODUCT_ID,
    XENA_CONNECTION_STATUS,
} = require('../modules/providers/xena.constants');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
    freshUser,
} = require('./testHelpers');

class FakeXenaAdapter {
    constructor(provider) {
        this.provider = provider;
    }

    async challengeConnection(params) {
        FakeXenaAdapter.challengeCalls.push(params);
        if (FakeXenaAdapter.challengeError) throw FakeXenaAdapter.challengeError;
        return {
            connectionId: params.connectionId || 'con_new',
            status: XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED,
            expiresAt: '2026-07-23T03:00:00.000Z',
            requestId: 'req_challenge',
        };
    }

    async verifyConnection(params) {
        FakeXenaAdapter.verifyCalls.push(params);
        if (FakeXenaAdapter.verifyError) throw FakeXenaAdapter.verifyError;
        return {
            connectionId: params.connectionId,
            status: XENA_CONNECTION_STATUS.CONNECTED,
            requestId: 'req_verify',
        };
    }

    async getConnection() {
        if (FakeXenaAdapter.connectionSnapshot) return FakeXenaAdapter.connectionSnapshot;
        return {
            connectionId: this.provider.xenaConfig.connectionId,
            status: this.provider.xenaConfig.connectionStatus,
            maskedUsername: 'ag***@example.com',
            displayName: 'Agency',
        };
    }

    async getBalance() {
        if (FakeXenaAdapter.balanceError) throw FakeXenaAdapter.balanceError;
        return FakeXenaAdapter.balanceResult || {
            balance: '12345',
            currency: null,
            checkedAt: '2026-07-23T03:00:00.000Z',
            source: 'xena_live',
            requestId: 'req_balance',
        };
    }

    async verifyTargetUser(params) {
        FakeXenaAdapter.verifyTargetCalls.push(params);
        if (FakeXenaAdapter.verifyTargetError) throw FakeXenaAdapter.verifyTargetError;
        return FakeXenaAdapter.verifyTargetResult || {
            uid: params.targetUid,
            targetUid: params.targetUid,
            nickname: 'Safe nickname',
            avatar: null,
            country: 'EG',
            valid: true,
            requestId: 'req_target',
        };
    }
}

FakeXenaAdapter.challengeCalls = [];
FakeXenaAdapter.verifyCalls = [];
FakeXenaAdapter.challengeError = null;
FakeXenaAdapter.verifyError = null;
FakeXenaAdapter.connectionSnapshot = null;
FakeXenaAdapter.balanceResult = null;
FakeXenaAdapter.balanceError = null;
FakeXenaAdapter.verifyTargetCalls = [];
FakeXenaAdapter.verifyTargetResult = null;
FakeXenaAdapter.verifyTargetError = null;

class MatrixXenaAdapter extends FakeXenaAdapter {
    async placeOrder(params) {
        MatrixXenaAdapter.placeCalls.push(params);
        const next = MatrixXenaAdapter.placeQueue.shift() || {
            success: true,
            providerOrderId: 'rch_default',
            providerStatus: 'Pending',
            rawResponse: { status: 'processing' },
        };
        if (next instanceof Error) throw next;
        return next;
    }

    async checkOrders(ids) {
        MatrixXenaAdapter.maxActive = Math.max(MatrixXenaAdapter.maxActive, ++MatrixXenaAdapter.active);
        try {
            if (MatrixXenaAdapter.statusError) throw MatrixXenaAdapter.statusError;
            await MatrixXenaAdapter.delay;
            MatrixXenaAdapter.checkCalls.push(ids);
            if (MatrixXenaAdapter.statusQueue.length) return MatrixXenaAdapter.statusQueue.shift();
            return ids.map((id) => ({
                providerOrderId: id,
                providerStatus: 'Pending',
                rawResponse: { status: 'processing' },
            }));
        } finally {
            MatrixXenaAdapter.active--;
        }
    }
}

MatrixXenaAdapter.reset = () => {
    MatrixXenaAdapter.placeQueue = [];
    MatrixXenaAdapter.statusQueue = [];
    MatrixXenaAdapter.placeCalls = [];
    MatrixXenaAdapter.checkCalls = [];
    MatrixXenaAdapter.statusError = null;
    MatrixXenaAdapter.active = 0;
    MatrixXenaAdapter.maxActive = 0;
    MatrixXenaAdapter.delay = Promise.resolve();
};
MatrixXenaAdapter.reset();

const resetFakeAdapter = () => {
    FakeXenaAdapter.challengeCalls = [];
    FakeXenaAdapter.verifyCalls = [];
    FakeXenaAdapter.challengeError = null;
    FakeXenaAdapter.verifyError = null;
    FakeXenaAdapter.connectionSnapshot = null;
    FakeXenaAdapter.balanceResult = null;
    FakeXenaAdapter.balanceError = null;
    FakeXenaAdapter.verifyTargetCalls = [];
    FakeXenaAdapter.verifyTargetResult = null;
    FakeXenaAdapter.verifyTargetError = null;
    MatrixXenaAdapter.reset();
    registerAdapter(XENA_PROVIDER_SLUG, FakeXenaAdapter);
    registerAdapter('xena recharge', FakeXenaAdapter);
};

const makeXenaProvider = (overrides = {}) => Provider.create({
    name: `Xena Recharge ${Date.now()} ${Math.random().toString(36).slice(2)}`,
    slug: XENA_PROVIDER_SLUG,
    baseUrl: 'https://api.digiteech.test',
    apiToken: 'xena-token',
    isActive: true,
    xenaConfig: {
        connectionId: 'con_existing',
        connectionStatus: XENA_CONNECTION_STATUS.CONNECTED,
        product: {
            externalProductId: XENA_DYNAMIC_PRODUCT_ID,
            name: 'Xena Dynamic Recharge',
            unitPrice: '1',
            minAmount: 1,
            maxAmount: 100000,
            isActive: true,
        },
        ...(overrides.xenaConfig || {}),
    },
    ...overrides,
});

const makeFakeAxios = () => ({
    post: jest.fn(),
    get: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
});

const makeXenaOrderFixture = async ({
    providerOrderId = 'rch_1',
    retryCount = 0,
    walletBalance = 1000,
    providerConfig = {},
    orderOverrides = {},
} = {}) => {
    const { customer, group } = await createCustomerWithGroup({ walletBalance, creditLimit: 0 }, { percentage: 0 });
    let provider = await Provider.findOne({ slug: XENA_PROVIDER_SLUG });
    if (!provider) {
        provider = await makeXenaProvider(providerConfig);
    }
    let providerProduct = await ProviderProduct.findOne({
        provider: provider._id,
        externalProductId: XENA_DYNAMIC_PRODUCT_ID,
    });
    if (!providerProduct) {
        providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: XENA_DYNAMIC_PRODUCT_ID,
            rawName: 'Xena Dynamic Recharge',
            rawPrice: '1',
            minQty: 1,
            maxQty: 100,
            isActive: true,
        });
    }
    const product = await Product.create({
        name: `Xena Auto ${Date.now()} ${Math.random().toString(36).slice(2)}`,
        basePrice: '10',
        minQty: 1,
        maxQty: 100,
        isActive: true,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        orderFields: [xenaSvc.getCanonicalOrderField()],
        providerMapping: { target_uid: 'targetUid' },
    });
    const order = await Order.create({
        orderNumber: 1000000000 + Math.floor(Math.random() * 900000000),
        userId: customer._id,
        productId: product._id,
        quantity: 10,
        unitPrice: '10',
        totalPrice: '10',
        basePriceSnapshot: '10',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '10',
        groupIdSnapshot: group._id,
        walletDeducted: 10,
        creditUsedAmount: '0',
        chargedAmount: 10,
        currency: 'USD',
        rateSnapshot: 1,
        usdAmount: '10',
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: XENA_PROVIDER_SLUG,
        providerOrderId,
        retryCount,
        customerInput: {
            values: { target_uid: '123456' },
            fieldsSnapshot: [xenaSvc.getCanonicalOrderField()],
        },
        ...orderOverrides,
    });
    return { customer, group, provider, providerProduct, product, order };
};

const walletTxCount = (userId) => WalletTransaction.countDocuments({ userId });

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    registerAdapter(XENA_PROVIDER_SLUG, XenaRechargeAdapter);
    registerAdapter('xena recharge', XenaRechargeAdapter);
    await disconnectTestDB();
});

beforeEach(async () => {
    jest.restoreAllMocks();
    await clearCollections();
    resetFakeAdapter();
});

describe('Xena credentials', () => {
    it('encrypts credentials at rest, decrypts internally, redacts serializers, and preserves blank updates', async () => {
        const provider = await makeXenaProvider({ apiToken: 'plain-secret' });
        expect(isEncrypted(provider.apiToken)).toBe(true);
        expect(decryptCredential(provider.apiToken)).toBe('plain-secret');
        expect(provider.effectiveToken).toBe('plain-secret');

        const json = provider.toJSON();
        expect(json.apiToken).toBeUndefined();
        expect(json.apiKey).toBeUndefined();
        expect(json.xenaConfig.connectionId).toBeUndefined();
        expect(json.credentialsConfigured).toBe(true);

        await providerService.updateProvider(provider._id, { apiToken: '' });
        const refreshed = await Provider.findById(provider._id);
        expect(decryptCredential(refreshed.apiToken)).toBe('plain-secret');
    });
});

describe('Xena connection lifecycle and product config', () => {
    it('challenges and verifies using the backend-stored connection id without persisting password or code', async () => {
        const provider = await makeXenaProvider({
            xenaConfig: { connectionId: 'con_old', connectionStatus: XENA_CONNECTION_STATUS.PENDING },
        });

        const challenge = await xenaSvc.challengeConnection(provider._id, {
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'super-secret-password',
        });
        expect(challenge).toMatchObject({ status: XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED });
        expect(challenge.connectionId).toBeUndefined();
        expect(JSON.stringify(challenge)).not.toContain('con_old');
        expect(FakeXenaAdapter.challengeCalls[0]).toMatchObject({ connectionId: 'con_old', username: 'agency@example.com' });
        expect(FakeXenaAdapter.challengeCalls[0].password).toBe('super-secret-password');

        const verify = await xenaSvc.verifyConnection(provider._id, { code: '123456', connectionId: 'browser-tamper' });
        expect(verify).toMatchObject({ status: XENA_CONNECTION_STATUS.CONNECTED });
        expect(verify.connectionId).toBeUndefined();
        expect(FakeXenaAdapter.verifyCalls[0]).toMatchObject({ connectionId: 'con_old', code: '123456' });

        const saved = await Provider.findById(provider._id).lean();
        expect(JSON.stringify(saved)).not.toContain('super-secret-password');
        expect(JSON.stringify(saved)).not.toContain('123456');

        const logs = await AuditLog.find({ entityId: provider._id }).lean();
        expect(JSON.stringify(logs)).not.toContain('super-secret-password');
        expect(JSON.stringify(logs)).not.toContain('123456');
    });

    it('preserves existing connection metadata when reconnect challenge fails', async () => {
        const provider = await makeXenaProvider({
            xenaConfig: {
                connectionId: 'con_old',
                connectionStatus: XENA_CONNECTION_STATUS.CONNECTED,
                displayName: 'Existing Agency',
                maskedUsername: 'old***@example.com',
            },
        });
        FakeXenaAdapter.challengeError = new XenaApiError('Challenge failed', {
            statusCode: 502,
            code: 'XENA_BAD_GATEWAY',
        });

        await expect(xenaSvc.challengeConnection(provider._id, {
            displayName: 'New Agency',
            username: 'new@example.com',
            password: 'new-password',
        })).rejects.toMatchObject({ code: 'XENA_BAD_GATEWAY' });

        const saved = await Provider.findById(provider._id).lean();
        expect(saved.xenaConfig).toMatchObject({
            connectionId: 'con_old',
            connectionStatus: XENA_CONNECTION_STATUS.CONNECTED,
            displayName: 'Existing Agency',
            maskedUsername: 'old***@example.com',
        });
        expect(JSON.stringify(saved)).not.toContain('new-password');
    });

    it('returns the admin Xena balance contract as a scalar without inventing currency', async () => {
        const provider = await makeXenaProvider();
        FakeXenaAdapter.balanceResult = {
            balance: '12345',
            currency: null,
            checkedAt: '2026-07-23T03:00:00.000Z',
            requestId: 'req_balance',
            source: 'xena_live',
        };

        const result = await adminProvidersService.getProviderBalance(provider._id);

        expect(result).toMatchObject({
            provider: provider.name,
            balance: '12345',
            currency: null,
            checkedAt: '2026-07-23T03:00:00.000Z',
            requestId: 'req_balance',
            source: 'xena_live',
        });
        expect(typeof result.balance).toBe('string');
        expect(result.balance).not.toBe('[object Object]');
    });

    it('verifies target UIDs as exact strings and returns safe metadata only', async () => {
        const provider = await makeXenaProvider();
        const result = await xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid: '001234567890',
        });

        expect(FakeXenaAdapter.verifyTargetCalls[0].targetUid).toBe('001234567890');
        expect(typeof FakeXenaAdapter.verifyTargetCalls[0].targetUid).toBe('string');
        expect(Number(FakeXenaAdapter.verifyTargetCalls[0].targetUid)).toBe(1234567890);
        expect(result).toMatchObject({
            valid: true,
            targetUid: '001234567890',
            user: {
                uid: '001234567890',
                nickname: 'Safe nickname',
                avatar: null,
                country: 'EG',
            },
        });
        expect(JSON.stringify(result)).not.toContain('connectionId');
        expect(JSON.stringify(result)).not.toContain('con_existing');
    });

    it.each([
        ['missing target', undefined],
        ['numeric target', 9178631],
        ['non-digit target', '91786a1'],
        ['too long target', '1'.repeat(51)],
    ])('rejects %s locally before calling Xena', async (_label, targetUid) => {
        const provider = await makeXenaProvider();
        await expect(xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid,
        })).rejects.toMatchObject({ code: 'INVALID_XENA_TARGET_UID' });
        expect(FakeXenaAdapter.verifyTargetCalls).toHaveLength(0);
    });

    it.each([
        ['not found', new XenaApiError('User not found', { statusCode: 404, code: 'USER_NOT_FOUND' }), 'XENA_TARGET_INVALID', 404],
        ['401 provider auth', new XenaApiError('Unauthorized', { statusCode: 401, code: 'XENA_UNAUTHORIZED' }), 'XENA_PROVIDER_AUTH_FAILED', 502],
        ['reauth required', new XenaApiError('Session expired', { statusCode: 409, code: 'REAUTHENTICATION_REQUIRED' }), 'XENA_REAUTHENTICATION_REQUIRED', 409],
        ['rate limited', new XenaApiError('Rate limit', { statusCode: 429, code: 'XENA_RATE_LIMIT' }), 'XENA_RATE_LIMITED', 429],
        ['timeout', new XenaApiError('Timeout', { code: 'ECONNABORTED', retryable: true, uncertain: true }), 'XENA_VERIFICATION_UNAVAILABLE', 503],
        ['upstream 500', new XenaApiError('Bad gateway', { statusCode: 500, code: 'XENA_BAD_GATEWAY' }), 'XENA_VERIFICATION_UNAVAILABLE', 503],
        ['malformed success response', new XenaApiError('Malformed response', { statusCode: 502, code: 'XENA_INVALID_TARGET_RESPONSE' }), 'XENA_VERIFICATION_UNAVAILABLE', 503],
    ])('maps upstream %s without collapsing to invalid UID', async (_label, error, expectedCode, expectedStatus) => {
        const provider = await makeXenaProvider();
        FakeXenaAdapter.verifyTargetError = error;

        await expect(xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid: '9178631',
        })).rejects.toMatchObject({ code: expectedCode, statusCode: expectedStatus });
        if (expectedCode !== 'XENA_TARGET_INVALID') {
            await expect(xenaSvc.verifyTargetForProduct({
                product: { _id: provider._id },
                provider,
                targetUid: '9178631',
            })).rejects.not.toMatchObject({ code: 'XENA_TARGET_INVALID' });
        }
        FakeXenaAdapter.verifyTargetError = null;
    });

    it('persists reauthentication state when verification proves the Xena connection is stale', async () => {
        const provider = await makeXenaProvider();
        FakeXenaAdapter.verifyTargetError = new XenaApiError('Session expired', {
            statusCode: 409,
            code: 'REAUTHENTICATION_REQUIRED',
        });

        await expect(xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid: '9178631',
        })).rejects.toMatchObject({ code: 'XENA_REAUTHENTICATION_REQUIRED' });

        const saved = await Provider.findById(provider._id).lean();
        expect(saved.xenaConfig.connectionId).toBe('con_existing');
        expect(saved.xenaConfig.connectionStatus).toBe(XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED);
    });

    it('returns a reauthentication error when no stored connection exists', async () => {
        const provider = await makeXenaProvider({
            xenaConfig: { connectionId: null, connectionStatus: XENA_CONNECTION_STATUS.CONNECTED },
        });

        await expect(xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid: '9178631',
        })).rejects.toMatchObject({ code: 'XENA_REAUTHENTICATION_REQUIRED', statusCode: 409 });
        expect(FakeXenaAdapter.verifyTargetCalls).toHaveLength(0);
    });

    it('target verification does not create orders, wallet transactions, or sensitive logs', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, creditLimit: 0 }, { percentage: 0 });
        const provider = await makeXenaProvider();
        FakeXenaAdapter.verifyTargetError = new XenaApiError('Rate limit', {
            statusCode: 429,
            code: 'XENA_RATE_LIMIT',
            requestId: 'req_safe',
        });

        await expect(xenaSvc.verifyTargetForProduct({
            product: { _id: provider._id },
            provider,
            targetUid: '9178631',
        })).rejects.toMatchObject({ code: 'XENA_RATE_LIMITED' });

        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await freshUser(customer._id)).walletBalance).toBe(100);
        const logged = JSON.stringify(warnSpy.mock.calls);
        expect(logged).toContain('verify_target_user');
        expect(logged).not.toContain('9178631');
        expect(logged).not.toContain('con_existing');
        expect(logged).not.toContain('xena-token');
        expect(logged).not.toContain('Authorization');
        warnSpy.mockRestore();
    });

    it.each([
        ['0.00001', true],
        ['1', true],
        ['0', false],
        ['-1', false],
        ['NaN', false],
        ['Infinity', false],
    ])('validates unitPrice=%s with Decimal.js rules', async (unitPrice, shouldPass) => {
        const provider = await makeXenaProvider();
        const promise = xenaSvc.updateProductConfig(provider._id, {
            unitPrice,
            minAmount: 1,
            maxAmount: 10,
            isActive: true,
        });

        if (shouldPass) {
            await expect(promise).resolves.toMatchObject({ unitPrice: String(unitPrice) });
        } else {
            await expect(promise).rejects.toMatchObject({ code: 'INVALID_XENA_UNIT_PRICE' });
        }
    });

    it('rejects unsafe min/max amounts and max below min', async () => {
        const provider = await makeXenaProvider();
        await expect(xenaSvc.updateProductConfig(provider._id, {
            unitPrice: '1',
            minAmount: Number.MAX_SAFE_INTEGER + 1,
            maxAmount: Number.MAX_SAFE_INTEGER + 2,
            isActive: true,
        })).rejects.toMatchObject({ code: 'INVALID_XENA_MIN_AMOUNT' });

        await expect(xenaSvc.updateProductConfig(provider._id, {
            unitPrice: '1',
            minAmount: 10,
            maxAmount: 9,
            isActive: true,
        })).rejects.toMatchObject({ code: 'INVALID_XENA_MAX_AMOUNT' });
    });

    it('syncs exactly one synthetic Xena provider product', async () => {
        registerAdapter(XENA_PROVIDER_SLUG, XenaRechargeAdapter);
        const provider = await makeXenaProvider({
            xenaConfig: {
                connectionId: 'con_existing',
                connectionStatus: XENA_CONNECTION_STATUS.CONNECTED,
                product: {
                    externalProductId: XENA_DYNAMIC_PRODUCT_ID,
                    name: 'Xena Dynamic Recharge',
                    unitPrice: '0.00001',
                    minAmount: 1,
                    maxAmount: 100000,
                    isActive: true,
                },
            },
        });

        await syncService.syncProvider(provider._id);
        await syncService.syncProvider(provider._id);

        const products = await ProviderProduct.find({ provider: provider._id });
        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({
            externalProductId: XENA_DYNAMIC_PRODUCT_ID,
            rawPrice: '0.00001',
            minQty: 1,
            maxQty: 100000,
            isActive: true,
        });
    });
});

describe('Xena admin HTTP connection lifecycle', () => {
    let server;
    let baseUrl;

    beforeAll((done) => {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    afterAll((done) => { server.close(done); });

    const adminToken = async () => {
        const admin = await createAdmin();
        return jwt.sign({ id: admin._id, role: admin.role }, config.jwt.secret, { expiresIn: '1h' });
    };

    const customerToken = async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, creditLimit: 0 }, { percentage: 0 });
        return {
            customer,
            token: jwt.sign({ id: customer._id, role: customer.role }, config.jwt.secret, { expiresIn: '1h' }),
        };
    };

    const request = async (method, path, token, body = undefined) => {
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, json };
    };

    it('covers challenge success, reconnect challenge, invalid input, and upstream challenge errors', async () => {
        const token = await adminToken();
        const provider = await makeXenaProvider({
            xenaConfig: { connectionId: null, connectionStatus: XENA_CONNECTION_STATUS.PENDING },
        });

        const success = await request('POST', `/api/admin/providers/${provider._id}/xena/challenge`, token, {
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'secret-password',
        });
        expect(success.status).toBe(200);
        expect(JSON.stringify(success.json)).not.toContain('secret-password');
        expect(JSON.stringify(success.json)).not.toContain('connectionId');
        expect(JSON.stringify(success.json)).not.toContain('con_new');
        expect(FakeXenaAdapter.challengeCalls[0]).toMatchObject({ username: 'agency@example.com' });
        expect(FakeXenaAdapter.challengeCalls[0].connectionId).toBeNull();

        const reconnect = await request('POST', `/api/admin/providers/${provider._id}/xena/challenge`, token, {
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'secret-password-2',
            connectionId: 'browser-tamper',
        });
        expect(reconnect.status).toBe(200);
        expect(FakeXenaAdapter.challengeCalls[1].connectionId).toBe('con_new');
        expect(FakeXenaAdapter.challengeCalls[1].connectionId).not.toBe('browser-tamper');
        expect(JSON.stringify(reconnect.json)).not.toContain('connectionId');
        expect(JSON.stringify(reconnect.json)).not.toContain('con_new');

        const invalid = await request('POST', `/api/admin/providers/${provider._id}/xena/challenge`, token, {
            displayName: 'Agency',
            username: 'agency@example.com',
        });
        expect(invalid.status).toBe(422);

        for (const [statusCode, code] of [[401, 'XENA_UNAUTHORIZED'], [409, 'XENA_CONNECTION_CONFLICT'], [429, 'XENA_RATE_LIMIT'], [502, 'XENA_BAD_GATEWAY']]) {
            FakeXenaAdapter.challengeError = new XenaApiError(code, { statusCode, code, retryable: statusCode >= 429, uncertain: statusCode >= 429 });
            const failed = await request('POST', `/api/admin/providers/${provider._id}/xena/challenge`, token, {
                displayName: 'Agency',
                username: 'agency@example.com',
                password: 'secret-password-3',
            });
            expect(failed.status).toBe(statusCode);
            expect(JSON.stringify(failed.json)).not.toContain('secret-password-3');
            FakeXenaAdapter.challengeError = null;
        }
    });

    it('covers verify success, invalid code, expired code, statuses, and secret redaction', async () => {
        const token = await adminToken();
        const provider = await makeXenaProvider({
            xenaConfig: { connectionId: 'con_verify', connectionStatus: XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED },
        });

        const verified = await request('POST', `/api/admin/providers/${provider._id}/xena/verify`, token, { code: '123456' });
        expect(verified.status).toBe(200);
        expect(FakeXenaAdapter.verifyCalls[0]).toMatchObject({ connectionId: 'con_verify', code: '123456' });
        expect(JSON.stringify(verified.json)).not.toContain('123456');
        expect(JSON.stringify(verified.json)).not.toContain('connectionId');
        expect(JSON.stringify(verified.json)).not.toContain('con_verify');

        for (const [statusCode, code] of [[400, 'INVALID_CODE'], [410, 'EXPIRED_CODE']]) {
            FakeXenaAdapter.verifyError = new XenaApiError(code, { statusCode, code });
            const failed = await request('POST', `/api/admin/providers/${provider._id}/xena/verify`, token, { code: '000000' });
            expect(failed.status).toBe(statusCode);
            expect(JSON.stringify(failed.json)).not.toContain('000000');
            FakeXenaAdapter.verifyError = null;
        }

        for (const status of [
            XENA_CONNECTION_STATUS.PENDING,
            XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED,
            XENA_CONNECTION_STATUS.CONNECTED,
            XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED,
            XENA_CONNECTION_STATUS.DISABLED,
        ]) {
            FakeXenaAdapter.connectionSnapshot = {
                connectionId: 'con_verify',
                status,
                displayName: 'Agency',
                maskedUsername: 'ag***@example.com',
            };
            const response = await request('GET', `/api/admin/providers/${provider._id}/xena/connection`, token);
            expect(response.status).toBe(200);
            expect(JSON.stringify(response.json)).toContain(status);
            expect(JSON.stringify(response.json)).not.toContain('connectionId');
            expect(JSON.stringify(response.json)).not.toContain('con_verify');
            expect(JSON.stringify(response.json)).not.toContain('xena-token');
            expect(JSON.stringify(response.json)).not.toContain('apiToken');
            expect(JSON.stringify(response.json)).not.toContain('123456');
            if (status === XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED) {
                expect(response.json.data.connection.needsReauthentication).toBe(true);
            }
        }

        const saved = await Provider.findById(provider._id).lean();
        expect(JSON.stringify(saved)).not.toContain('123456');
        expect(JSON.stringify(saved)).not.toContain('secret-password');
    });

    it('verifies a customer Xena target without accepting or exposing browser connection ids', async () => {
        const { token } = await customerToken();
        const provider = await makeXenaProvider();
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: XENA_DYNAMIC_PRODUCT_ID,
            rawName: 'Xena Dynamic Recharge',
            rawPrice: '1',
            minQty: 1,
            maxQty: 100,
            isActive: true,
        });
        const product = await Product.create({
            name: 'Xena Product',
            basePrice: '1',
            minQty: 1,
            maxQty: 100,
            isActive: true,
            executionType: 'manual',
            provider: provider._id,
            providerProduct: providerProduct._id,
            orderFields: [xenaSvc.getCanonicalOrderField()],
            providerMapping: { target_uid: 'targetUid' },
        });

        const response = await request('POST', `/api/me/products/${product._id}/verify-target`, token, {
            targetUid: ' 001234 ',
            connectionId: 'browser-tamper',
        });

        expect(response.status).toBe(200);
        expect(FakeXenaAdapter.verifyTargetCalls[0]).toMatchObject({ targetUid: '001234' });
        expect(FakeXenaAdapter.verifyTargetCalls[0]).not.toHaveProperty('connectionId');
        expect(JSON.stringify(response.json)).not.toContain('connectionId');
        expect(JSON.stringify(response.json)).not.toContain('con_existing');
        expect(response.json.data).toMatchObject({
            valid: true,
            targetUid: '001234',
            user: { uid: '001234' },
        });
    });

    it('only connected Xena providers enable fulfillment preflight', async () => {
        for (const status of [
            XENA_CONNECTION_STATUS.PENDING,
            XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED,
            XENA_CONNECTION_STATUS.REAUTHENTICATION_REQUIRED,
            XENA_CONNECTION_STATUS.DISABLED,
        ]) {
            const provider = { xenaConfig: { connectionStatus: status } };
            expect(() => xenaSvc.ensureConnectedForFulfillment(provider)).toThrow(
                expect.objectContaining({ code: 'XENA_CONNECTION_NOT_READY' })
            );
        }
        const connected = { xenaConfig: { connectionStatus: XENA_CONNECTION_STATUS.CONNECTED } };
        expect(() => xenaSvc.ensureConnectedForFulfillment(connected)).not.toThrow();
    });
});

describe('Xena order safety', () => {
    const makeXenaProduct = async () => {
        const provider = await makeXenaProvider();
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: XENA_DYNAMIC_PRODUCT_ID,
            rawName: 'Xena Dynamic Recharge',
            rawPrice: '1',
            minQty: 1,
            maxQty: 100,
            isActive: true,
        });
        const product = await Product.create({
            name: 'Xena Product',
            basePrice: '1',
            minQty: 1,
            maxQty: 100,
            isActive: true,
            executionType: 'manual',
            provider: provider._id,
            providerProduct: providerProduct._id,
            orderFields: [xenaSvc.getCanonicalOrderField()],
            providerMapping: { target_uid: 'targetUid' },
        });
        return { provider, providerProduct, product };
    };

    it('verifies Xena target before wallet debit and order creation', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, creditLimit: 0 }, { percentage: 0 });
        const { product } = await makeXenaProduct();
        const verifySpy = jest.spyOn(xenaSvc, 'verifyTargetForProduct')
            .mockRejectedValueOnce(Object.assign(new Error('invalid target'), { code: 'XENA_TARGET_INVALID' }))
            .mockResolvedValueOnce({ uid: '123456', valid: true });

        await expect(createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 2,
            orderFieldsValues: { target_uid: '123456' },
        })).rejects.toMatchObject({ code: 'XENA_TARGET_INVALID' });

        expect(verifySpy).toHaveBeenCalledTimes(1);
        expect(await Order.countDocuments()).toBe(0);
        expect((await freshUser(customer._id)).walletBalance).toBe(100);

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 2,
            orderFieldsValues: { target_uid: '123456' },
        });

        expect(verifySpy).toHaveBeenCalledTimes(2);
        expect(order.totalPrice).toBe('2');
        expect((await freshUser(customer._id)).walletBalance).toBe(98);
    });
});

describe('Xena adapter idempotency and uncertainty', () => {
    it('includes a backend-stored connection id on reconnect challenge and omits it for first-time challenge', async () => {
        const provider = await makeXenaProvider();
        const client = makeFakeAxios();
        client.post.mockResolvedValue({ data: { data: { connectionId: 'con_new', status: XENA_CONNECTION_STATUS.VERIFICATION_REQUIRED } } });
        const adapter = new XenaRechargeAdapter(provider, { client });

        await adapter.challengeConnection({
            connectionId: 'con_existing',
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'secret-password',
        });
        expect(client.post.mock.calls[0][1]).toMatchObject({
            connectionId: 'con_existing',
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'secret-password',
        });

        await adapter.challengeConnection({
            connectionId: null,
            displayName: 'Agency',
            username: 'agency@example.com',
            password: 'secret-password',
        });
        expect(client.post.mock.calls[1][1]).not.toHaveProperty('connectionId');
    });

    it.each([
        ['numeric balance', 12345, '12345'],
        ['numeric-string balance', '12345.6789', '12345.6789'],
        ['wrapped balance', { balance: '777' }, '777'],
        ['data wrapped balance', { data: { balance: 88.5 } }, '88.5'],
    ])('normalizes %s to a safe scalar string', async (_label, upstream, expected) => {
        const provider = await makeXenaProvider();
        const client = makeFakeAxios();
        client.get.mockResolvedValue({ data: upstream });
        const adapter = new XenaRechargeAdapter(provider, { client });

        const result = await adapter.getBalance();
        expect(result).toMatchObject({
            balance: expected,
            currency: null,
            source: 'xena_live',
        });
        expect(result.balance).not.toBe('[object Object]');
    });

    it.each([
        ['malformed object', { balance: { amount: '12' } }],
        ['missing balance', { data: {} }],
        ['array balance', { balance: ['12'] }],
        ['infinite balance', { balance: 'Infinity' }],
    ])('rejects %s balance safely', async (_label, upstream) => {
        const provider = await makeXenaProvider();
        const client = makeFakeAxios();
        client.get.mockResolvedValue({ data: upstream });
        const adapter = new XenaRechargeAdapter(provider, { client });

        await expect(adapter.getBalance()).rejects.toMatchObject({
            code: 'XENA_INVALID_BALANCE_RESPONSE',
            statusCode: 502,
        });
    });

    it('retries the same order with identical idempotency key and immutable body', async () => {
        const provider = await makeXenaProvider();
        const client = makeFakeAxios();
        client.post.mockResolvedValue({ data: { id: 'rch_1', status: 'processing' } });
        const adapter = new XenaRechargeAdapter(provider, { client });

        const params = {
            quantity: 50,
            targetUid: '123456',
            orderId: 'order-id',
            clientReference: 'order-10001',
            providerIdempotencyKey: 'xena-order-order-id',
        };
        await adapter.placeOrder(params);
        await adapter.placeOrder(params);

        expect(client.post.mock.calls[0]).toEqual(client.post.mock.calls[1]);
        expect(client.post.mock.calls[0][2]).toEqual({ headers: { 'Idempotency-Key': 'xena-order-order-id' } });
    });

    it.each(['unknown', 'processing'])('maps %s without a definite failure refund signal', async (status) => {
        const provider = await makeXenaProvider();
        const client = makeFakeAxios();
        client.post.mockResolvedValueOnce({ data: { id: 'rch_1', status } });
        const adapter = new XenaRechargeAdapter(provider, { client });

        const result = await adapter.placeOrder({
            quantity: 50,
            targetUid: '123456',
            orderId: 'order-id',
            clientReference: 'order-10001',
            providerIdempotencyKey: 'xena-order-order-id',
        });

        expect(result.success).toBe(true);
        expect(result.providerStatus).toBe(status === 'unknown' ? 'Unknown' : 'Pending');
        expect(result.providerStatus).not.toBe('Failed');
    });
});

describe('Xena polling, refund safety, and leases', () => {
    beforeEach(() => {
        registerAdapter(XENA_PROVIDER_SLUG, MatrixXenaAdapter);
        registerAdapter('xena recharge', MatrixXenaAdapter);
    });

    it.each([
        ['processing with providerOrderId', { providerOrderId: 'rch_proc' }, [{ providerOrderId: 'rch_proc', providerStatus: 'Pending', rawResponse: { status: 'processing' } }], ORDER_STATUS.PROCESSING, 0],
        ['processing -> succeeded', { providerOrderId: 'rch_ok' }, [{ providerOrderId: 'rch_ok', providerStatus: 'Completed', rawResponse: { status: 'succeeded' } }], ORDER_STATUS.COMPLETED, 0],
        ['processing -> failed', { providerOrderId: 'rch_fail' }, [{ providerOrderId: 'rch_fail', providerStatus: 'Failed', rawResponse: { status: 'failed' } }], ORDER_STATUS.FAILED, 1],
        ['unknown -> succeeded', { providerOrderId: 'rch_unknown_ok' }, [{ providerOrderId: 'rch_unknown_ok', providerStatus: 'Completed', rawResponse: { status: 'succeeded' } }], ORDER_STATUS.COMPLETED, 0],
        ['unknown -> failed', { providerOrderId: 'rch_unknown_fail' }, [{ providerOrderId: 'rch_unknown_fail', providerStatus: 'Failed', rawResponse: { status: 'failed' } }], ORDER_STATUS.FAILED, 1],
    ])('%s', async (_label, orderOpts, results, expectedStatus, expectedRefunds) => {
        const { order, customer } = await makeXenaOrderFixture(orderOpts);
        const action = await processOrderStatusResult(order, results[0]);
        const fresh = await Order.findById(order._id);

        if (expectedStatus === ORDER_STATUS.PROCESSING) {
            expect(action.action).toBe('pending');
        }
        expect(fresh.status).toBe(expectedStatus);
        expect(await walletTxCount(customer._id)).toBe(expectedRefunds);
    });

    it('repeated unknown reaches MANUAL_REVIEW without refund', async () => {
        const { order, customer } = await makeXenaOrderFixture({
            providerOrderId: 'rch_unknown_loop',
            retryCount: MAX_RETRY_COUNT - 1,
        });

        await processOrderStatusResult(order, {
            providerOrderId: 'rch_unknown_loop',
            providerStatus: 'Unknown',
            outcomeUncertain: true,
            rawResponse: { status: 'unknown', outcomeUncertain: true },
        });

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.refunded).toBe(false);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it('persists Xena recharge ID and request trace separately for processing create responses', async () => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: 'rch_created_processing',
            providerStatus: 'Pending',
            providerOutcome: 'processing',
            requestId: 'req_create_trace',
            rawResponse: { id: 'rch_created_processing', status: 'processing', requestId: 'req_create_trace' },
        });

        await executeOrder(order._id);

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
        expect(fresh.providerOrderId).toBe('rch_created_processing');
        expect(fresh.providerRequestId).toBe('req_create_trace');
        expect(fresh.providerRequestId).not.toBe(fresh.providerOrderId);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it('marks Xena order completed immediately when create response is already succeeded', async () => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: 'rch_created_done',
            providerStatus: 'Completed',
            requestId: 'req_done_trace',
            rawResponse: { id: 'rch_created_done', status: 'succeeded', requestId: 'req_done_trace' },
        });

        await executeOrder(order._id);

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.COMPLETED);
        expect(fresh.providerOrderId).toBe('rch_created_done');
        expect(fresh.providerRequestId).toBe('req_done_trace');
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it('processing create response without a recharge ID is not left silently pollable forever', async () => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: null,
            providerStatus: 'Pending',
            outcomeUncertain: true,
            errorCode: 'XENA_RECHARGE_ID_MISSING',
            requestId: 'req_missing_id',
            rawResponse: { status: 'processing', requestId: 'req_missing_id', code: 'XENA_RECHARGE_ID_MISSING', outcomeUncertain: true },
        });

        await executeOrder(order._id);

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.providerOrderId).toBeNull();
        expect(fresh.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        expect(fresh.refunded).toBe(false);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it.each([
        ['timeout'],
        ['429'],
        ['ambiguous 502'],
    ])('%s placement uncertainty without recharge ID moves to manual review without a second provider POST', async () => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: null,
            providerStatus: 'Pending',
            outcomeUncertain: true,
            errorCode: 'XENA_RECHARGE_ID_MISSING',
            requestId: 'req_missing_id',
            rawResponse: { status: 'processing', requestId: 'req_missing_id', code: 'XENA_RECHARGE_ID_MISSING', outcomeUncertain: true },
        });

        await executeOrder(order._id);
        await pollProcessingOrders();

        const fresh = await Order.findById(order._id);
        expect(MatrixXenaAdapter.placeCalls).toHaveLength(1);
        expect(MatrixXenaAdapter.placeCalls[0]).toMatchObject({
            orderId: String(order._id),
            clientReference: `order-${order.orderNumber}`,
            providerIdempotencyKey: `xena-order-${order._id}`,
            targetUid: '123456',
            quantity: 10,
        });
        expect(fresh.providerOrderId).toBeNull();
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        expect(fresh.refunded).toBe(false);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it.each([
        ['polling timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
        ['polling 429', Object.assign(new Error('rate limited'), { response: { status: 429 } })],
        ['polling 502', Object.assign(new Error('bad gateway'), { response: { status: 502 } })],
    ])('%s preserves state and does not refund', async (_label, error) => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: 'rch_preserve' });
        MatrixXenaAdapter.statusError = error;

        const stats = await pollProcessingOrders();
        const fresh = await Order.findById(order._id);

        expect(stats.pending).toBe(1);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
        expect(fresh.refunded).toBe(false);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it('polling backfills a Xena providerOrderId from stored wrapped raw response before status checks', async () => {
        const { order } = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: {
                providerRawResponse: { data: { id: 'rch_recovered', status: 'processing' }, requestId: 'req_trace_only' },
                providerRequestId: 'req_trace_only',
            },
        });
        MatrixXenaAdapter.statusQueue.push([
            { providerOrderId: 'rch_recovered', providerStatus: 'Completed', requestId: 'req_status', rawResponse: { id: 'rch_recovered', status: 'succeeded', requestId: 'req_status' } },
        ]);

        const stats = await pollProcessingOrders();

        const fresh = await Order.findById(order._id);
        expect(stats.completed).toBe(1);
        expect(MatrixXenaAdapter.placeCalls).toHaveLength(0);
        expect(MatrixXenaAdapter.checkCalls[0]).toEqual(['rch_recovered']);
        expect(fresh.providerOrderId).toBe('rch_recovered');
        expect(fresh.providerRequestId).toBe('req_status');
        expect(fresh.status).toBe(ORDER_STATUS.COMPLETED);
    });

    it('polling moves null-providerOrderId Xena orders with only requestId to manual review', async () => {
        const { order, customer } = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: {
                providerRawResponse: { status: 'processing', requestId: 'req_only' },
                providerRequestId: 'req_only',
            },
        });

        const stats = await pollProcessingOrders();

        const fresh = await Order.findById(order._id);
        expect(stats.manualReview).toBe(1);
        expect(MatrixXenaAdapter.placeCalls).toHaveLength(0);
        expect(MatrixXenaAdapter.checkCalls).toHaveLength(0);
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        expect(fresh.providerOrderId).toBeNull();
        expect(fresh.refunded).toBe(false);
        expect(await walletTxCount(customer._id)).toBe(0);
    });

    it('definite failed recharge refunds exactly once across repeated failed handling', async () => {
        const { order, customer } = await makeXenaOrderFixture({ providerOrderId: 'rch_failed_once' });
        const failed = { providerOrderId: 'rch_failed_once', providerStatus: 'Failed', rawResponse: { status: 'failed' } };

        await Promise.all([
            processOrderStatusResult(order, failed),
            processOrderStatusResult(order, failed),
        ]);
        await processOrderStatusResult(await Order.findById(order._id), failed);

        const fresh = await Order.findById(order._id);
        expect(fresh.status).toBe(ORDER_STATUS.FAILED);
        expect(fresh.refunded).toBe(true);
        expect(await walletTxCount(customer._id)).toBe(1);
    });

    it('unknown, timeout, 429, ambiguous 502, and uncertainty MANUAL_REVIEW never refund automatically', async () => {
        const unknown = await makeXenaOrderFixture({ providerOrderId: 'rch_no_refund_unknown' });
        await processOrderStatusResult(unknown.order, {
            providerOrderId: 'rch_no_refund_unknown',
            providerStatus: 'Unknown',
            outcomeUncertain: true,
            rawResponse: { outcomeUncertain: true },
        });

        for (const statusCode of [429, 502]) {
            const fixture = await makeXenaOrderFixture({ providerOrderId: null });
            MatrixXenaAdapter.placeQueue.push({
                success: true,
                providerOrderId: null,
                providerStatus: 'Pending',
                outcomeUncertain: true,
                rawResponse: { statusCode, outcomeUncertain: true },
            });
            await executeOrder(fixture.order._id);
            expect(await walletTxCount(fixture.customer._id)).toBe(0);
        }

        const timeoutFixture = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: null,
            providerStatus: 'Pending',
            outcomeUncertain: true,
            rawResponse: { code: 'ETIMEDOUT', outcomeUncertain: true },
        });
        await executeOrder(timeoutFixture.order._id);

        const manual = await makeXenaOrderFixture({ providerOrderId: 'rch_manual', retryCount: MAX_RETRY_COUNT - 1 });
        await processOrderStatusResult(manual.order, {
            providerOrderId: 'rch_manual',
            providerStatus: 'Unknown',
            outcomeUncertain: true,
            rawResponse: { outcomeUncertain: true },
        });

        expect(await walletTxCount(unknown.customer._id)).toBe(0);
        expect(await walletTxCount(timeoutFixture.customer._id)).toBe(0);
        expect(await walletTxCount(manual.customer._id)).toBe(0);
        expect((await Order.findById(manual.order._id)).status).toBe(ORDER_STATUS.MANUAL_REVIEW);
    });

    it('reconciliation dry run reports actions without modifying Xena orders', async () => {
        const recoverable = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { providerRawResponse: { data: { rechargeId: 'rch_dry_recover', status: 'processing' }, requestId: 'req_dry' } },
        });
        const unrecoverable = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { providerRawResponse: { status: 'processing', requestId: 'req_not_id' }, providerRequestId: 'req_not_id' },
        });

        const summary = await inspectXenaProcessingOrders({
            db: Order.db.db,
            apply: false,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });

        expect(summary).toMatchObject({ scanned: 2, backfillable: 1, manualReview: 1, modified: 0, dryRun: true });
        expect((await Order.findById(recoverable.order._id)).providerOrderId).toBeNull();
        expect((await Order.findById(unrecoverable.order._id)).status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('reconciliation backfills only proven recharge IDs and rejects requestId as an ID', async () => {
        const recoverable = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { providerRawResponse: { id: 'rch_apply_recover', status: 'processing', requestId: 'req_apply' } },
        });
        const unrecoverable = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { providerRawResponse: { status: 'processing', requestId: 'req_trace_only' }, providerRequestId: 'req_trace_only' },
        });

        const first = await inspectXenaProcessingOrders({
            db: Order.db.db,
            apply: true,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });
        const second = await inspectXenaProcessingOrders({
            db: Order.db.db,
            apply: true,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });

        const recovered = await Order.findById(recoverable.order._id);
        const manual = await Order.findById(unrecoverable.order._id);
        expect(first.modified).toBe(2);
        expect(second.scanned).toBe(0);
        expect(recovered.providerOrderId).toBe('rch_apply_recover');
        expect(recovered.providerOrderId).not.toBe('req_apply');
        expect(manual.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(manual.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        expect(manual.providerOrderId).toBeNull();
        expect(MatrixXenaAdapter.placeCalls).toHaveLength(0);
        expect(await walletTxCount(recoverable.customer._id)).toBe(0);
        expect(await walletTxCount(unrecoverable.customer._id)).toBe(0);
    });

    it('lease matrix: one claim, active lease blocks, expired lease reclaims, and release after success/failure', async () => {
        const success = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: 'rch_success_lock',
            providerStatus: 'Completed',
            rawResponse: { status: 'succeeded' },
        });
        const [first, second] = await Promise.all([
            executeOrder(success.order._id),
            executeOrder(success.order._id),
        ]);
        expect([first.placed, second.placed].filter(Boolean)).toHaveLength(1);
        expect((await Order.findById(success.order._id)).fulfillmentLockUntil).toBeNull();
        expect(MatrixXenaAdapter.placeCalls).toHaveLength(1);

        const active = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { fulfillmentLockUntil: new Date(Date.now() + 60_000), fulfillmentLockOwner: 'other-worker' },
        });
        const blocked = await executeOrder(active.order._id);
        expect(blocked.locked).toBe(true);

        const expired = await makeXenaOrderFixture({
            providerOrderId: null,
            orderOverrides: { fulfillmentLockUntil: new Date(Date.now() - 60_000), fulfillmentLockOwner: 'crashed-worker' },
        });
        MatrixXenaAdapter.placeQueue.push({
            success: false,
            providerOrderId: null,
            providerStatus: 'Failed',
            rawResponse: { status: 'failed' },
            errorMessage: 'failed',
        });
        await executeOrder(expired.order._id);
        const failedFresh = await Order.findById(expired.order._id);
        expect(failedFresh.status).toBe(ORDER_STATUS.FAILED);
        expect(failedFresh.fulfillmentLockUntil).toBeNull();
        expect(await walletTxCount(expired.customer._id)).toBe(1);
    });

    it('cron/admin race paths do not create duplicate Xena recharges or refunds', async () => {
        const retry = await makeXenaOrderFixture({ providerOrderId: null });
        MatrixXenaAdapter.placeQueue.push({
            success: true,
            providerOrderId: 'rch_race',
            providerStatus: 'Pending',
            rawResponse: { status: 'processing' },
        });
        await Promise.all([executeOrder(retry.order._id), pollProcessingOrders()]);
        expect(MatrixXenaAdapter.placeCalls.length).toBeLessThanOrEqual(1);
        const retryFresh = await Order.findById(retry.order._id);
        if (MatrixXenaAdapter.placeCalls.length === 1) {
            expect(retryFresh.providerOrderId).toBe('rch_race');
        } else {
            expect(retryFresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
            expect(retryFresh.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        }

        const failed = await makeXenaOrderFixture({ providerOrderId: 'rch_status_race' });
        MatrixXenaAdapter.statusQueue.push([
            { providerOrderId: 'rch_status_race', providerStatus: 'Failed', rawResponse: { status: 'failed' } },
        ]);
        await Promise.all([
            processOrderStatusResult(failed.order, {
                providerOrderId: 'rch_status_race',
                providerStatus: 'Failed',
                rawResponse: { status: 'failed' },
            }),
            pollProcessingOrders(),
        ]);
        expect(await walletTxCount(failed.customer._id)).toBe(1);
    });

    it('Xena status polling uses bounded concurrency', async () => {
        registerAdapter(XENA_PROVIDER_SLUG, XenaRechargeAdapter);
        const provider = await makeXenaProvider();
        let active = 0;
        let maxActive = 0;
        const client = makeFakeAxios();
        client.get.mockImplementation(async (url) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return { data: { id: url.split('/').pop(), status: 'processing' } };
        });
        const adapter = new XenaRechargeAdapter(provider, { client, statusConcurrency: 2 });
        await adapter.checkOrders(['a', 'b', 'c', 'd', 'e']);
        expect(maxActive).toBeLessThanOrEqual(2);
    });
});

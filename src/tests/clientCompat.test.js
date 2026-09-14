'use strict';

const http = require('http');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createProduct, countTransactions } = require('./testHelpers');
const { Category } = require('../modules/categories/category.model');
const { Setting } = require('../modules/admin/setting.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { User } = require('../modules/users/user.model');

let app; let server; let baseUrl;
const request = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(path, baseUrl), { method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); } catch (error) { reject(error); } });
    }); req.on('error', reject); if (payload) req.write(payload); req.end();
});
const get = (path, headers) => request('GET', path, undefined, headers);
const post = (path, body, headers) => request('POST', path, body, headers);
const headers = (token, alias = 'api-token') => alias === 'authorization' ? { Authorization: `Bearer ${token}` } : { [alias]: token };
const apiUser = async (overrides = {}) => {
    const token = overrides.token || `compat-${Date.now()}-${Math.random()}`;
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD', isApiEnabled: true, apiToken: token, ...overrides }, { percentage: 0, isActive: true });
    return { customer, group, token };
};
const product = (overrides = {}) => createProduct({ basePrice: 10, minQty: 1, maxQty: 1, executionType: 'manual', orderFields: [{ id: 'player_id', key: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }], ...overrides });

beforeAll(async () => { await connectTestDB(); app = require('../app'); await new Promise((done) => { server = app.listen(0, done); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise((done) => server.close(done)); await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

describe('Canonical client compatibility HTTP contract', () => {
    test('auth aliases, disabled account and IP allowlist return canonical codes only', async () => {
        expect((await get('/client/api/profile')).body.code).toBe(120);
        expect((await get('/client/api/profile', headers('invalid'))).body.code).toBe(121);
        const disabled = await apiUser({ isApiEnabled: false });
        expect((await get('/client/api/profile', headers(disabled.token))).body.code).toBe(122);
        const allowed = await apiUser({ whitelistIps: ['203.0.113.9'] });
        expect((await get('/client/api/profile', headers(allowed.token))).body.code).toBe(123);
        const active = await apiUser();
        expect((await get('/api/client/api/profile', headers(active.token, 'x-api-key'))).status).toBe(200);
        expect((await get('/client/api/profile', headers(active.token, 'authorization'))).status).toBe(200);
    });

    test('tokens are bcrypt-only at rest and regeneration invalidates the previous token', async () => {
        const { customer, token } = await apiUser();
        const stored = await User.findById(customer._id).select('+apiToken'); expect(stored.apiToken).not.toBe(token); expect(await stored.compareApiToken(token)).toBe(true);
        stored.apiToken = 'replacement-token'; await stored.save();
        expect(await stored.compareApiToken(token)).toBe(false); expect(await stored.compareApiToken('replacement-token')).toBe(true);
        expect(stored.toSafeObject()).not.toHaveProperty('apiToken');
    });

    test('profile, product variants and content expose stable public shapes', async () => {
        const { token } = await apiUser(); const category = await Category.create({ name: 'Games', isActive: true });
        const saved = await product({ category: category._id });
        const auth = headers(token); const profile = await get('/client/api/profile', auth);
        expect(profile.body).toMatchObject({ currency: 'USD' });
        const products = await get('/client/api/products', auth); expect(products.status).toBe(200); const ProductModel = require('../modules/products/product.model').Product; expect(await ProductModel.countDocuments({ isActive: true, deletedAt: null })).toBe(1); expect(await ProductModel.find({ isActive: true, deletedAt: null }).select('compatProductId name description image category minQty maxQty basePrice orderFields dynamicFields displayOrder isActive deletedAt').lean()).toHaveLength(1); expect(products.body).toEqual(expect.any(Array)); expect(products.body).not.toEqual([]); const row = products.body[0];
        expect(row).toMatchObject({ id: 1000, currency: 'USD', params: ['Player ID'], fields: [expect.objectContaining({ key: 'player_id', required: true })], qty_values: null });
        expect((await get(`/client/api/products?products_id=${row.id}`, auth)).body).toHaveLength(1);
        expect((await get('/client/api/products?base=1', auth)).body[0]).toEqual({ id: row.id, name: saved.name, price: 10, currency: 'USD' });
        const root = await get('/client/api/content/0', auth); expect(root.body.data.categories[0]).toMatchObject({ id: expect.any(Number), name: 'Games' });
        expect((await get(`/client/api/content/${root.body.data.categories[0].id}`, auth)).body.data.products[0].id).toBe(row.id);
    });

    test('old products receive an atomic compatibility ID lazily without backfill', async () => {
        const { token } = await apiUser(); const legacy = await product(); await legacy.updateOne({ $unset: { compatProductId: 1 } });
        const response = await get('/client/api/products', headers(token)); expect(response.body[0].id).toEqual(expect.any(Number));
        const persisted = await require('../modules/products/product.model').Product.findById(legacy._id).lean(); expect(persisted.compatProductId).toBe(response.body[0].id);
    });

    test('orders are idempotent, compatible checks work and statuses map', async () => {
        const { customer, token } = await apiUser(); await product(); const auth = headers(token);
        const productRow = (await get('/client/api/products', auth)).body[0];
        expect((await post('/client/api/orders', { product_id: productRow.id, qty: 1 }, auth)).body.code).toBe(124);
        expect((await post('/client/api/orders', { product_id: productRow.id, qty: 1, order_uuid: 'bad-params', params: [] }, auth)).body.code).toBe(124);
        const first = await post('/client/api/orders', { product_id: productRow.id, qty: 1, order_uuid: 'stable-1', params: { player_id: '1' } }, auth);
        expect(first.body.data).toMatchObject({ order_id: expect.stringMatching(/^ID_/), order_uuid: 'stable-1', status: 'wait', currency: 'USD' });
        const before = await countTransactions(customer._id); const repeat = await post('/client/api/orders', { product_id: productRow.id, qty: 1, order_uuid: 'stable-1', params: { player_id: '1' } }, auth);
        expect(repeat.body.data.order_id).toBe(first.body.data.order_id); expect(await countTransactions(customer._id)).toBe(before);
        expect((await get(`/client/api/check?orders=${first.body.data.order_id}`, auth)).body.data[0]).toMatchObject({ order_uuid: 'stable-1', status: 'wait' });
        expect((await get('/client/api/check?uuids=stable-1', auth)).body.data[0].order_id).toBe(first.body.data.order_id);
        const legacy = await get(`/client/api/newOrder/${productRow.id}/params?qty=1&order_uuid=legacy-1&player_id=2`, auth); expect(legacy.body.data.order_uuid).toBe('legacy-1');
        await Order.updateOne({ compatOrderId: first.body.data.order_id }, { $set: { status: ORDER_STATUS.COMPLETED } }); expect((await get(`/client/api/check?orders=${first.body.data.order_id}`, auth)).body.data[0].status).toBe('accept');
        await Order.updateOne({ compatOrderId: first.body.data.order_id }, { $set: { status: ORDER_STATUS.FAILED } }); expect((await get(`/client/api/check?orders=${first.body.data.order_id}`, auth)).body.data[0].status).toBe('reject');
    });

    test('maintenance and limiter use canonical numeric errors', async () => {
        const { token } = await apiUser(); await product(); const auth = headers(token); const row = (await get('/client/api/products', auth)).body[0];
        await Setting.create({ key: 'maintenanceMode', value: true, isPublic: false });
        const response = await post('/client/api/orders', { product_id: row.id, qty: 1, order_uuid: 'maintenance' }, auth); expect(response).toMatchObject({ status: 503, body: { code: 130 } });
        const { compatRateLimitHandler } = require('../shared/middlewares/rateLimiter'); const json = jest.fn(); const status = jest.fn(() => ({ json })); compatRateLimitHandler({}, { status }); expect(status).toHaveBeenCalledWith(429); expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 111 }));
    });
});

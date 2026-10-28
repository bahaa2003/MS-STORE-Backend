'use strict';

jest.mock('axios');
const axios = require('axios');
const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { getAdapter, getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');

const provider = {
    name: 'Brand One Card', slug: 'brand-one-card',
    baseUrl: 'https://api.brand-one-card.com/', apiToken: 'test-token',
};
let http;
let adapter;
beforeEach(() => {
    http = { get: jest.fn() };
    axios.create.mockReturnValue(http);
    adapter = new BrandOneCardAdapter(provider);
});
const reply = (data) => ({ data });
const order = (status = 'accept') => ({ order_id: '482913', order_uuid: 'MS-123', status, replay_api: ['Done'] });
const placement = { externalProductId: '365', quantity: 2, referenceId: 'MS-123', playerId: '5123456789' };

test('configures token header, base URL and timeout', () => {
    expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'https://api.brand-one-card.com', timeout: 180000,
        headers: expect.objectContaining({ 'api-token': 'test-token' }),
    }));
    expect(() => new BrandOneCardAdapter({ ...provider, apiToken: null })).toThrow(/apiToken/);
});

test.each(['brand-one-card', 'brand one card', 'brandonecard'])('resolves new provider key %s', (key) => {
    expect(getAdapter({ ...provider, slug: key })).toBeInstanceOf(BrandOneCardAdapter);
    expect(getProviderAdapter({ ...provider, slug: '', name: key }, { strict: true })).toBeInstanceOf(BrandOneCardAdapter);
});
test('resolves adapterType and preserves the separate brand1-card adapter', () => {
    expect(getAdapter({ ...provider, slug: 'custom', adapterType: 'brand-one-card' })).toBeInstanceOf(BrandOneCardAdapter);
    for (const key of ['brand1-card', 'brand1 card', 'brand1card']) {
        axios.create.mockReturnValue({ ...http, interceptors: { response: { use: jest.fn() } } });
        expect(getAdapter({ ...provider, slug: key })).toBeInstanceOf(AlkasrVipAdapter);
    }
});

test('maps product ranges and preserves product metadata and exact price strings', async () => {
    const row = { id: 365, name: 'UC 60', price: '0.104', qty_values: { min: 1, max: 15000 }, product_type: 'amount', params: ['playerId'], params_info: [{ key: 'playerId', required: true }], currency: 'USD', available: true };
    http.get.mockResolvedValue(reply([row, { ...row, id: 366, qty_values: null, product_type: 'package', available: false }]));
    const products = await adapter.fetchProducts();
    expect(products[0]).toMatchObject({ externalProductId: '365', rawPrice: '0.104', minQty: 1, maxQty: 15000, rawPayload: row });
    expect(products[1]).toMatchObject({ minQty: 1, maxQty: 1, isActive: false });
});
test('rejects non-USD costs instead of treating them as USD', async () => {
    http.get.mockResolvedValue(reply([{ id: 1, name: 'Item', price: 10, currency: 'EUR' }]));
    await expect(adapter.getProducts()).rejects.toThrow(/require USD/);
});
test('publishes fixed-price packages as single purchases even with a supplier range', async () => {
    http.get.mockResolvedValue(reply([{ id: 2, name: 'Package', price: '5', product_type: 'package', qty_values: { min: 1, max: 10 } }]));
    expect((await adapter.getProducts())[0]).toMatchObject({ rawPrice: '5', minQty: 1, maxQty: 1 });
});
test.each(['getProducts', 'getBalance', 'getContent'])('%s surfaces HTTP 200 API errors', async (method) => {
    http.get.mockResolvedValue(reply({ status: 'ERROR', code: 123, msg: 'IP not allowed' }));
    await expect(adapter[method]()).rejects.toThrow('IP not allowed');
});
test('reads profile and category content', async () => {
    http.get.mockResolvedValueOnce(reply({ balance: '8788.68', currency: 'USD' }))
        .mockResolvedValueOnce(reply({ status: 'OK', categories: [], products: [] }));
    expect(await adapter.getMyInfo()).toMatchObject({ balance: '8788.68', currency: 'USD' });
    await adapter.getContent();
    expect(http.get.mock.calls.map(([path]) => path)).toEqual(['/client/api/profile', '/client/api/content/0']);
});

test.each([['accept', 'Completed'], ['wait', 'Pending'], ['reject', 'Cancelled'], ['unknown', 'Pending']])('maps %s placement and check status to %s', async (status, expected) => {
    http.get.mockResolvedValueOnce(reply({ status: 'OK', data: order(status) }))
        .mockResolvedValueOnce(reply({ status: 'OK', data: [order(status)] }));
    expect(await adapter.placeOrder(placement)).toMatchObject({ providerOrderId: '482913', providerStatus: expected });
    expect(await adapter.checkOrder('482913')).toMatchObject({ providerOrderId: '482913', providerStatus: expected });
});
test('passes dynamic customer fields, protects reserved query fields and reuses stable references', async () => {
    http.get.mockResolvedValue(reply({ status: 'OK', data: order() }));
    await adapter.placeOrder({ ...placement, orderId: 'internal', providerIdempotencyKey: 'unused', serverId: 'EU', qty: 99, order_uuid: 'override' });
    const second = new BrandOneCardAdapter(provider, { httpClient: http });
    await second.placeOrder(placement);
    expect(http.get).toHaveBeenNthCalledWith(1, '/client/api/newOrder/365/params', {
        params: { playerId: '5123456789', serverId: 'EU', qty: 2, order_uuid: 'MS-123' },
    });
    expect(http.get.mock.calls[1][1].params.order_uuid).toBe('MS-123');
});
test('allows products without playerId and nested customer parameters', async () => {
    http.get.mockResolvedValue(reply({ status: 'OK', data: order() }));
    await adapter.placeOrder({ ...placement, params: { email: 'buyer@example.com', qty: 999 } });
    expect(http.get.mock.calls[0][1].params).toEqual({ email: 'buyer@example.com', qty: 2, order_uuid: 'MS-123' });
});
test.each([100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 120, 121, 122, 123, 500])('treats explicit API error %s as an uncharged rejection', async (code) => {
    http.get.mockResolvedValue(reply({ status: 'ERROR', code, msg: 'Rejected' }));
    expect(await adapter.placeOrder(placement)).toMatchObject({ success: false, providerStatus: 'Cancelled', errorCode: code });
    expect(http.get).toHaveBeenCalledTimes(1);
});
test.each([{}, { ...placement, referenceId: '' }, { ...placement, quantity: 0 }, { ...placement, quantity: 1.5 }])('validates placement before HTTP', async (params) => {
    expect(await adapter.placeOrder(params)).toMatchObject({ success: false, providerStatus: 'Cancelled' });
    expect(http.get).not.toHaveBeenCalled();
});
test('recovers a timed out placement by the same reference', async () => {
    http.get.mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(reply({ status: 'OK', data: [order()] }));
    expect(await adapter.placeOrder(placement)).toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Completed' });
    expect(http.get).toHaveBeenLastCalledWith('/client/api/check', { params: { uuid: 1, orders: '["MS-123"]' } });
});
test.each([reply({ status: 'OK', data: [] }), reply({ status: 'ERROR', code: 123, msg: 'IP not allowed' })])('keeps unresolved placements pending for later reference recovery', async (recovery) => {
    http.get.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(recovery);
    expect(await adapter.placeOrder(placement)).toMatchObject({ success: true, outcomeUncertain: true, providerStatus: 'Pending', providerOrderId: null });
});
test('recovers a malformed placement response rather than refunding', async () => {
    http.get.mockResolvedValueOnce(reply({ status: 'OK', data: {} }))
        .mockResolvedValueOnce(reply({ status: 'OK', data: [order('wait')] }));
    expect(await adapter.placeOrder(placement)).toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Pending' });
});
test('batch checks use JSON arrays and ignore unrelated orders', async () => {
    http.get.mockResolvedValue(reply({ status: 'OK', data: [order(), { ...order(), order_id: '999' }] }));
    expect(await adapter.checkOrdersBatch(['482913'])).toHaveLength(1);
    expect(http.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: '["482913"]' } });
    expect(await adapter.checkOrders([])).toEqual([]);
});
test('empty check is pending and API check errors throw', async () => {
    http.get.mockResolvedValueOnce(reply({ status: 'OK', data: [] }))
        .mockResolvedValueOnce(reply({ status: 'ERROR', code: 121, msg: 'Token error' }));
    expect(await adapter.checkOrder('482913')).toMatchObject({ providerStatus: 'Pending' });
    await expect(adapter.checkOrder('482913')).rejects.toThrow('Token error');
});

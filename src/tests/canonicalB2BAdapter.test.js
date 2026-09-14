'use strict';
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const provider = { adapterType: 'canonical-b2b', baseUrl: 'https://upstream.example/client/api/', apiToken: 'test-token' };
const make = () => { const client = { get: jest.fn(), post: jest.fn() }; return { client, adapter: new CanonicalB2BAdapter(provider, { httpClient: client }) }; };
describe('CanonicalB2BAdapter', () => {
    test('uses the complete base, api-token, product mapping and USD safety', async () => {
        const configured = new CanonicalB2BAdapter(provider); expect(configured._client.defaults.baseURL).toBe('https://upstream.example/client/api'); expect(configured._client.defaults.headers['api-token']).toBe('test-token');
        const { adapter, client } = make(); client.get.mockResolvedValueOnce({ data: [{ id: 1000, name: 'UC', price: 1, fields: [{ key: 'player' }], qty_values: { min: 1, max: 2 } }] }); const [row] = await adapter.getProducts(); expect(row).toMatchObject({ externalProductId: '1000', minQty: 1, maxQty: 2, rawPayload: { fields: [{ key: 'player' }] } });
        client.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'bad', price: 1, currency: 'EGP' }] }); await expect(adapter.getProducts()).rejects.toThrow(/EGP/);
    });
    test('places using orderNumber reference, checks IDs/UUID and recovers uncertainty', async () => {
        const { adapter, client } = make(); client.post.mockResolvedValueOnce({ data: { status: 'OK', data: { order_id: 'ID-1', status: 'wait' } } }); await expect(adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'ORDER-1', orderId: 'mongo-id', clientReference: 'internal-reference', providerIdempotencyKey: 'internal-key', player_id: '7' })).resolves.toMatchObject({ success: true, providerOrderId: 'ID-1' }); expect(client.post).toHaveBeenCalledWith('/orders', expect.objectContaining({ order_uuid: 'ORDER-1', params: { player_id: '7' } }));
        client.get.mockResolvedValueOnce({ data: { data: [{ order_id: 'ID-1', status: 'wait' }] } }); await expect(adapter.checkOrder('ID-1')).resolves.toMatchObject({ providerOrderId: 'ID-1' });
        client.post.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })); client.get.mockResolvedValueOnce({ data: { data: [{ order_id: 'ID-2', order_uuid: 'ORDER-2', status: 'wait' }] } }); await expect(adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'ORDER-2' })).resolves.toMatchObject({ success: true, providerOrderId: 'ID-2' });
    });
    test('an unresolved ambiguous placement stays explicitly uncertain for fulfillment recovery', async () => {
        const { adapter, client } = make(); client.post.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); client.get.mockResolvedValueOnce({ data: { data: [] } });
        await expect(adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'ORDER-3' })).resolves.toMatchObject({ success: true, outcomeUncertain: true, providerStatus: 'PLACEMENT_UNCERTAIN', providerOrderId: null });
    });
});

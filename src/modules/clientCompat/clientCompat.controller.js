'use strict';
const service = require('./clientCompat.service'); const { parseOrdersQuery } = require('./clientCompat.mappers');
const noStore = (res) => res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', Pragma: 'no-cache', Expires: '0' });
const getProfile = async (req, res) => res.json(await service.getProfile(req.reseller));
const listProducts = async (req, res) => res.json(await service.listProducts(req.reseller, { productsId: req.query.products_id, base: String(req.query.base) === '1' }));
const getContent = async (req, res) => res.json(await service.getContent(req.reseller, req.params.parentId));
const placeCanonicalOrder = async (req, res) => {
    noStore(res);
    const params = req.body?.params;
    if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) {
        const { ClientCompatError, ERROR_CODES } = require('./clientCompat.errors');
        throw new ClientCompatError('params must be an object', ERROR_CODES.VALIDATION, 400);
    }
    res.json(await service.create(req.reseller, req.body?.product_id, req.body?.qty, req.body?.order_uuid, params || {}, req.auditContext));
};
const placeOrder = async (req, res) => { noStore(res); const params = { ...req.query }; delete params.qty; delete params.order_uuid; res.json(await service.create(req.reseller, req.params.productId, req.query.qty, req.query.order_uuid, params, req.auditContext)); };
const checkOrders = async (req, res) => { noStore(res); const byUuid = req.query.uuids !== undefined || String(req.query.uuid) === '1'; res.json(await service.listOrders(req.reseller, parseOrdersQuery(req.query.uuids ?? req.query.orders), byUuid)); };
module.exports = { getProfile, listProducts, getContent, placeCanonicalOrder, placeOrder, checkOrders };

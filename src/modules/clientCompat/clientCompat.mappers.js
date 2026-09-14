'use strict';

const { ORDER_STATUS } = require('../orders/order.model');

const mapStatus = (status) => {
    if (status === ORDER_STATUS.COMPLETED) return 'accept';
    if ([ORDER_STATUS.FAILED, ORDER_STATUS.CANCELED].includes(status)) return 'reject';
    return 'wait';
};
const fieldsFor = (product) => (Array.isArray(product.orderFields) && product.orderFields.length ? product.orderFields : product.dynamicFields || [])
    .filter((field) => field && field.isActive !== false);
const fieldKey = (field) => String(field.key || field.name || field.id || '').trim();
const fieldLabel = (field) => String(field.label || field.name || field.key || field.id || '').trim();
const fields = (product) => fieldsFor(product).map((field) => ({
    key: fieldKey(field), label: fieldLabel(field), type: String(field.type || 'text'), required: field.required !== false,
    options: Array.isArray(field.options) ? field.options : [],
})).filter((field) => field.key && field.label);
const quantity = (product) => Number(product.maxQty) > Number(product.minQty || 1)
    ? { min: String(product.minQty || 1), max: String(product.maxQty) } : null;
const price = (value) => Number(Number(value || 0).toFixed(6));
const orderData = (order) => ({ ...(order.customerInput?.values || order.customInputs || {}) });
const orderPrice = (order) => order.chargedAmount ?? order.totalPrice ?? 0;
const mapProduct = ({ product, category, finalPrice, currency, minimal = false }) => {
    const basic = { id: Number(product.compatProductId), name: product.name, price: price(finalPrice), currency };
    if (minimal) return basic;
    const qtyValues = quantity(product);
    return {
        ...basic, cost: basic.price, rate: basic.price, api_price: basic.price, provider_price: basic.price,
        base_price: price(product.basePrice), original_price: price(product.basePrice),
        available: product.isActive !== false && !product.deletedAt, parent_id: Number(category?.compatCategoryId || 0),
        category_name: category?.name || '', category_img: category?.image || '', params: fieldsFor(product).map(fieldLabel).filter(Boolean),
        fields: fields(product), qty_values: qtyValues, product_type: qtyValues ? 'amount' : 'package',
        min: qtyValues ? Number(qtyValues.min) : 1, max: qtyValues ? Number(qtyValues.max) : 1,
    };
};
const mapCreatedOrder = (order) => ({ order_id: order.compatOrderId, order_uuid: order.idempotencyKey || null, status: mapStatus(order.status), price: price(orderPrice(order)), currency: String(order.currency || 'USD').toUpperCase(), data: orderData(order), replay_api: null });
const mapCheckedOrder = (order) => ({ order_id: order.compatOrderId, order_uuid: order.idempotencyKey || null, quantity: Number(order.quantity || 0), data: orderData(order), created_at: new Date(order.createdAt).toISOString().replace('T', ' ').slice(0, 19), product_name: order.productId?.name || null, price: String(orderPrice(order)), status: mapStatus(order.status), replay_api: null });
const parseOrdersQuery = (value) => {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    const source = String(value || '').trim(); if (!source) return [];
    try { const parsed = JSON.parse(source); if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean); } catch (_) { /* CSV is legacy supported */ }
    return source.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().replace(/^['\"]|['\"]$/g, '')).filter(Boolean);
};
module.exports = { mapStatus, fieldsFor, fieldKey, fieldLabel, fields, mapProduct, mapCreatedOrder, mapCheckedOrder, parseOrdersQuery };

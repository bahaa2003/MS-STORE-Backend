'use strict';

const crypto = require('crypto');
const { Product } = require('../products/product.model');
const { Category } = require('../categories/category.model');
const { Order } = require('../orders/order.model');
const { getNextSequence } = require('../orders/counter.model');
const orderService = require('../orders/order.service');
const { calculateFinalPrice } = require('../orders/pricing.service');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { ClientCompatError, ERROR_CODES } = require('./clientCompat.errors');
const { fieldsFor, fieldKey, fieldLabel, mapProduct, mapCreatedOrder, mapCheckedOrder } = require('./clientCompat.mappers');

const publicSelect = 'compatProductId name description image category minQty maxQty basePrice orderFields dynamicFields displayOrder isActive deletedAt';
const ensure = async (Model, id, key, counter, start) => {
    if (id?.[key]) return id[key];
    const documentId = id?._id || id;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const value = key === 'compatOrderId' ? `ID_${crypto.randomBytes(8).toString('hex')}` : await getNextSequence(counter, start);
        try {
            const updated = await Model.findOneAndUpdate({ _id: documentId, $or: [{ [key]: null }, { [key]: { $exists: false } }] }, { $set: { [key]: value } }, { new: true, lean: true });
            if (updated?.[key]) return updated[key];
            const existing = await Model.findById(documentId).select(key).lean(); if (existing?.[key]) return existing[key];
        } catch (error) { if (error.code !== 11000) throw error; }
    }
    throw new ClientCompatError('Unable to assign compatibility ID', 500, 500);
};
const ensureProductCompatId = (product) => ensure(Product, product, 'compatProductId', 'compatProductId', 999);
const ensureCategoryCompatId = (category) => ensure(Category, category, 'compatCategoryId', 'compatCategoryId', 1);
const ensureCompatOrderId = (order) => ensure(Order, order, 'compatOrderId');
const priceFor = async (product, reseller) => {
    const usd = calculateFinalPrice(product.basePrice, Number(reseller.groupId?.percentage || 0));
    const currency = String(reseller.currency || 'USD').toUpperCase();
    const converted = await convertUsdToUserCurrency(Number(usd), currency);
    return { finalPrice: converted.finalAmount, currency };
};
const categories = async () => Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
const assignIds = async (products, cats) => {
    await Promise.all(cats.filter((category) => !category.compatCategoryId).map(async (category) => { category.compatCategoryId = await ensureCategoryCompatId(category); }));
    await Promise.all(products.filter((product) => !product.compatProductId).map(async (product) => { product.compatProductId = await ensureProductCompatId(product); }));
};
const getProfile = async (reseller) => ({ balance: String(Number(reseller.availableBalance ?? (reseller.walletBalance || 0) + (reseller.creditLimit || 0)).toFixed(6)), email: reseller.email || null, currency: String(reseller.currency || 'USD').toUpperCase() });
const listProducts = async (reseller, { productsId = '', base = false } = {}) => {
    const wanted = String(productsId || '').split(',').map((value) => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
    // Fetch before filtering by the public ID.  Old rows created before this
    // additive field exists must receive their stable ID on first compat use;
    // filtering at Mongo level would make those rows permanently invisible
    // until an operator runs the optional backfill script.
    const filter = { isActive: true, deletedAt: null };
    const [products, cats] = await Promise.all([Product.find(filter).select(publicSelect).sort({ displayOrder: 1, name: 1 }).lean(), categories()]);
    await assignIds(products, cats); const categoryById = new Map(cats.map((category) => [String(category._id), category]));
    const visible = wanted.length ? products.filter((product) => wanted.includes(Number(product.compatProductId))) : products;
    return Promise.all(visible.map(async (product) => mapProduct({ product, category: categoryById.get(String(product.category)), ...(await priceFor(product, reseller)), minimal: base })));
};
const getContent = async (reseller, parentId) => {
    const parent = Number(parentId); if (!Number.isInteger(parent) || parent < 0) throw new ClientCompatError('Validation error', 124, 400);
    const [products, cats] = await Promise.all([Product.find({ isActive: true, deletedAt: null }).select(publicSelect).sort({ displayOrder: 1, name: 1 }).lean(), categories()]);
    await assignIds(products, cats); const categoryByCompat = new Map(cats.map((category) => [Number(category.compatCategoryId), category])); const current = parent ? categoryByCompat.get(parent) : null;
    const children = cats.filter((category) => parent ? String(category.parentCategory || '') === String(current?._id || '') : !category.parentCategory).map((category) => ({ id: Number(category.compatCategoryId), name: category.name, parent_id: parent, image: category.image || '', available: category.isActive !== false }));
    const visible = products.filter((product) => parent ? String(product.category || '') === String(current?._id || '') : !product.category);
    const categoryById = new Map(cats.map((category) => [String(category._id), category]));
    return { status: 'OK', data: { categories: children, products: await Promise.all(visible.map(async (product) => mapProduct({ product, category: categoryById.get(String(product.category)), ...(await priceFor(product, reseller)) }))) } };
};
const normalizeFields = (product, submitted = {}) => {
    const aliases = new Map(); for (const field of fieldsFor(product)) for (const alias of [fieldKey(field), fieldLabel(field), field.name, field.id]) if (alias) aliases.set(String(alias).trim().toLowerCase(), fieldKey(field));
    return Object.fromEntries(Object.entries(submitted || {}).map(([key, value]) => [aliases.get(String(key).trim().toLowerCase()) || key, value]));
};
const create = async (reseller, productId, qty, uuid, params, auditContext) => {
    if (productId === undefined || !String(productId).trim()) throw new ClientCompatError('product_id is required', 124, 400);
    if (!String(uuid || '').trim()) throw new ClientCompatError('order_uuid is required', 124, 400);
    // Resolve old records lazily before lookup, as listProducts does.  This
    // keeps the public contract usable during a rolling production backfill.
    const requestedProductId = Number(productId);
    if (!Number.isInteger(requestedProductId) || requestedProductId <= 0) throw new ClientCompatError('Product deleted or not found', 109, 404);
    let product = await Product.findOne({ compatProductId: requestedProductId, deletedAt: null }).select(publicSelect);
    if (!product) {
        const legacyProducts = await Product.find({ $or: [{ compatProductId: null }, { compatProductId: { $exists: false } }], deletedAt: null }).select(publicSelect).lean();
        await assignIds(legacyProducts, []);
        product = await Product.findOne({ compatProductId: requestedProductId, deletedAt: null }).select(publicSelect);
    }
    if (!product) throw new ClientCompatError('Product deleted or not found', 109, 404); if (!product.isActive) throw new ClientCompatError('Product not available now', 110, 400);
    const quantity = Number(qty); if (!Number.isInteger(quantity) || quantity <= 0) throw new ClientCompatError('Quantity not allowed', 106, 400);
    if (quantity < product.minQty) throw new ClientCompatError('Quantity is too small', 112, 400); if (quantity > product.maxQty) throw new ClientCompatError('Quantity is too large', 113, 400);
    const result = await orderService.createOrder({ userId: reseller._id, productId: product._id, quantity, idempotencyKey: String(uuid).trim(), orderFieldsValues: normalizeFields(product, params), auditContext });
    const compatOrderId = await ensureCompatOrderId(result.order); const order = await Order.findById(result.order._id).populate('productId', 'name').lean(); order.compatOrderId = compatOrderId;
    return { status: 'OK', data: mapCreatedOrder(order) };
};
const listOrders = async (reseller, ids, byUuid) => {
    if (!ids.length) throw new ClientCompatError('Validation error', 124, 400);
    const filter = byUuid ? { userId: reseller._id, idempotencyKey: { $in: ids } } : { userId: reseller._id, compatOrderId: { $in: ids } };
    const rows = await Order.find(filter).populate('productId', 'name').lean();
    for (const row of rows) if (!row.compatOrderId) row.compatOrderId = await ensureCompatOrderId(row);
    const index = new Map(rows.map((row) => [String(byUuid ? row.idempotencyKey : row.compatOrderId), row]));
    return { status: 'OK', data: ids.map(String).map((id) => index.get(id)).filter(Boolean).map(mapCheckedOrder) };
};
module.exports = { getProfile, listProducts, getContent, create, listOrders, ensureProductCompatId, ensureCategoryCompatId, ensureCompatOrderId };

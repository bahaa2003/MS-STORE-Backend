'use strict';

// Provider.baseUrl is the complete remote Canonical B2B base. It is never
// rewritten or appended with /client/api here.
const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const DEFAULT_TIMEOUT_MS = 180_000;
const SECRET_KEY = /token|api[_-]?key|authorization|password|secret/i;
const sanitize = (value) => Array.isArray(value) ? value.map(sanitize) : (!value || typeof value !== 'object' ? value : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item)])));
const normaliseBaseUrl = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');
const errorDetails = (error) => ({
    httpStatus: error?.response?.status ?? error?.statusCode ?? null,
    body: sanitize(error?.response?.data ?? error?.providerBody ?? null),
    message: String(error?.message || 'Provider request failed'),
    code: error?.code || null,
});
const uncertain = (error) => {
    const status = error?.response?.status; const code = error?.code; const bodyCode = Number(error?.response?.data?.code);
    if (bodyCode === 111 || bodyCode === 130 || (status && status < 500)) return false;
    return Boolean(status >= 500 || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED'].includes(code) || /timeout|socket|network|connection reset/i.test(String(error?.message || '')));
};
class CanonicalB2BAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken(); const baseURL = normaliseBaseUrl(provider.baseUrl);
        if (!baseURL) throw new Error('[CanonicalB2B] provider.baseUrl is required');
        if (!token) throw new Error('[CanonicalB2B] api token (apiToken / apiKey) is required');
        this._client = options.httpClient || axios.create({ baseURL, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, headers: { 'api-token': token, 'Content-Type': 'application/json', Accept: 'application/json' } });
    }
    async getBalance() { const { data } = await this._client.get('/profile'); return { balance: data?.balance, currency: data?.currency, email: data?.email, rawResponse: sanitize(data) }; }
    async getProducts() {
        const { data } = await this._client.get('/products'); const rows = Array.isArray(data) ? data : (data?.data?.products || data?.products || []);
        if (!Array.isArray(rows)) throw new Error('[CanonicalB2B] GET /products returned an invalid product list');
        return rows.map((row) => {
            const currency = row.currency == null ? null : String(row.currency).trim().toUpperCase(); if (currency && currency !== 'USD') throw new Error(`[CanonicalB2B] Product ${row.id ?? '<unknown>'} declares ${currency}; provider sync supports USD only.`);
            const range = row.qty_values && !Array.isArray(row.qty_values) && Number.isFinite(Number(row.qty_values.min)) && Number.isFinite(Number(row.qty_values.max)) ? row.qty_values : null;
            return this._validateDTO({ externalProductId: String(row.id), rawName: String(row.name || 'Unknown'), rawPrice: String(row.price), minQty: range ? Number(range.min) : 1, maxQty: range ? Number(range.max) : 1, isActive: row.available !== false, rawPayload: sanitize(row) });
        });
    }
    _readCheckItems(data) { return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []); }
    _normaliseCheckItem(item) { return item?.order_id == null ? null : { providerOrderId: item.order_id, providerStatus: item.status ?? 'wait', rawResponse: sanitize(item) }; }
    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[CanonicalB2B] referenceId is required for reference lookup');
        const { data } = await this._client.get('/check', { params: { uuids: String(referenceId) } });
        const item = this._readCheckItems(data).find((row) => String(row?.order_uuid || '') === String(referenceId));
        const normalized = this._normaliseCheckItem(item);
        return normalized ? { found: true, ...normalized } : { found: false, rawResponse: sanitize(data) };
    }
    async _recoverUncertainPlacement(referenceId, placementError) {
        try {
            const recovered = await this.checkOrderByReference(referenceId);
            if (recovered.found) return { success: true, providerOrderId: recovered.providerOrderId, providerStatus: recovered.providerStatus, rawResponse: recovered.rawResponse, errorMessage: null };
            return { success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN', outcomeUncertain: true, rawResponse: { placement: 'uncertain', recovery: 'not_found', httpStatus: errorDetails(placementError).httpStatus }, errorMessage: null };
        } catch (recoveryError) {
            return { success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN', outcomeUncertain: true, rawResponse: { placement: 'uncertain', recovery: 'lookup_failed', httpStatus: errorDetails(placementError).httpStatus, recoveryHttpStatus: errorDetails(recoveryError).httpStatus }, errorMessage: null };
        }
    }
    async placeOrder(params = {}) {
        const externalProductId = String(params.externalProductId ?? params.providerProductId ?? params.productId ?? '').trim();
        const referenceId = String(params.referenceId || '').trim();
        if (!/^\d+$/.test(externalProductId) || Number(externalProductId) <= 0) return { success: false, providerOrderId: null, providerStatus: 'reject', errorMessage: 'Canonical B2B product ID must be a positive numeric compatibility ID', rawResponse: { validation: 'invalid_product_id' } };
        if (!referenceId) return { success: false, providerOrderId: null, providerStatus: 'reject', errorMessage: 'Canonical B2B referenceId is required', rawResponse: { validation: 'missing_reference_id' } };
        try {
            const {
                externalProductId: _externalProductId, providerProductId: _providerProductId,
                productId: _productId, quantity: _quantity, amount: _amount,
                referenceId: _referenceId, orderId: _orderId, clientReference: _clientReference,
                providerIdempotencyKey: _providerIdempotencyKey,
                price: _price, basePrice: _basePrice, providerPrice: _providerPrice,
                walletBalance: _walletBalance, balance: _balance, currency: _currency,
                params: _params, orderFields: _orderFields,
                ...orderFields
            } = params;
            const { data } = await this._client.post('/orders', { product_id: Number(externalProductId), qty: params.quantity ?? params.amount, order_uuid: referenceId, params: params.params || params.orderFields || orderFields });
            const row = data?.data;
            if (data?.status !== 'OK' || !row?.order_id) return { success: false, providerOrderId: null, providerStatus: 'reject', errorMessage: row?.message || data?.message || 'Canonical B2B provider rejected the order', rawResponse: sanitize(data) };
            return { success: true, providerOrderId: row.order_id, providerStatus: row.status ?? 'wait', rawResponse: sanitize(data), errorMessage: null };
        } catch (error) {
            if (uncertain(error)) return this._recoverUncertainPlacement(referenceId, error);
            const details = errorDetails(error); return { success: false, providerOrderId: null, providerStatus: 'reject', errorMessage: details.body?.message || details.message, rawResponse: { httpStatus: details.httpStatus, code: details.body?.code ?? null, message: details.body?.message || details.message } };
        }
    }
    async checkOrder(id) { const rows = await this.checkOrders([id]); return rows[0] || { providerOrderId: id, providerStatus: 'wait', rawResponse: null }; }
    async checkOrders(ids) {
        if (!Array.isArray(ids) || !ids.length) return [];
        const { data } = await this._client.get('/check', { params: { orders: ids.join(',') } }); const requested = new Set(ids.map(String));
        return this._readCheckItems(data).map((row) => this._normaliseCheckItem(row)).filter((row) => row && requested.has(String(row.providerOrderId)));
    }
}
module.exports = { CanonicalB2BAdapter, sanitize, normaliseBaseUrl };

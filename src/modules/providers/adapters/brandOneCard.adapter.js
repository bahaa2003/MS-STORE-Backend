'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

const API = '/client/api';
// Fulfillment passes mapped customer fields alongside its internal arguments.
const INTERNAL_FIELDS = new Set([
    'productId', 'externalProductId', 'providerProductId', 'quantity', 'amount',
    'referenceId', 'orderId', 'clientReference', 'providerIdempotencyKey',
    'order_uuid', 'orderUuid', 'qty', 'params', 'orderFields',
    'price', 'basePrice', 'providerPrice', 'walletBalance', 'balance', 'currency',
]);

const normaliseStatus = (status) => {
    switch (String(status ?? '').toLowerCase().trim()) {
        case 'accept': return 'Completed';
        case 'reject': return 'Cancelled';
        // Missing or unrecognized statuses must never trigger a refund.
        default: return 'Pending';
    }
};

class BrandOneCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[BrandOneCard] provider.baseUrl is required');
        if (!token) throw new Error('[BrandOneCard] apiToken / apiKey is required');
        this._client = options.httpClient || axios.create({
            baseURL: String(provider.baseUrl).replace(/\/+$/, ''),
            timeout: options.timeoutMs ?? 180000,
            headers: { 'api-token': token, Accept: 'application/json' },
        });
    }

    _assertNoApiError(body) {
        if (body?.status === 'ERROR') {
            const error = new Error(`[BrandOneCard] ${body.msg || body.detail || 'Provider API error'}`);
            error.providerCode = body.code;
            throw error;
        }
    }

    async getBalance() {
        const { data } = await this._client.get(`${API}/profile`);
        this._assertNoApiError(data);
        if (data?.balance == null) throw new Error('[BrandOneCard] Invalid profile response');
        return data;
    }

    async getProducts() {
        const { data } = await this._client.get(`${API}/products`);
        this._assertNoApiError(data);
        if (!Array.isArray(data)) throw new Error('[BrandOneCard] Invalid products response');
        return data.map((item) => {
            if (item?.id == null) throw new Error('[BrandOneCard] Product ID is missing');
            const currency = String(item.currency ?? '').trim().toUpperCase();
            if (currency && currency !== 'USD') {
                throw new Error(`[BrandOneCard] Product ${item.id} declares ${currency}; platform product costs require USD`);
            }
            return this._validateDTO({
                externalProductId: String(item.id),
                rawName: item.name,
                rawPrice: item.price,
                // Platform pricing multiplies rawPrice by quantity. Publish fixed
                // packages as one purchase so their fixed cost is preserved.
                minQty: item.product_type === 'package' ? 1 : (item.qty_values?.min ?? 1),
                maxQty: item.product_type === 'package' ? 1 : (item.qty_values?.max ?? 1),
                isActive: item.available !== false,
                // Keep product_type, currency, params and params_info for mapping.
                rawPayload: item,
            });
        });
    }

    async getContent(categoryId = 0) {
        const { data } = await this._client.get(`${API}/content/${encodeURIComponent(categoryId)}`);
        this._assertNoApiError(data);
        if (data?.status !== 'OK' || !Array.isArray(data.categories) || !Array.isArray(data.products)) {
            throw new Error('[BrandOneCard] Invalid content response');
        }
        return data;
    }

    _orderResult(row) {
        if (row?.order_id == null) throw new Error('[BrandOneCard] Missing provider order ID');
        return {
            providerOrderId: String(row.order_id),
            providerStatus: normaliseStatus(row.status),
            unifiedStatus: this.toUnifiedStatus(normaliseStatus(row.status)),
            rawResponse: row,
        };
    }

    async _check(ids, byUuid = false) {
        const { data } = await this._client.get(`${API}/check`, {
            params: { orders: JSON.stringify(ids), ...(byUuid ? { uuid: 1 } : {}) },
        });
        this._assertNoApiError(data);
        if (data?.status !== 'OK' || !Array.isArray(data.data)) {
            throw new Error('[BrandOneCard] Invalid check response');
        }
        return data.data;
    }

    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];
        const requested = new Set(orderIds.map(String));
        return (await this._check(orderIds))
            .filter((row) => requested.has(String(row.order_id)))
            .map((row) => this._orderResult(row));
    }

    async checkOrder(orderId) {
        const rows = await this.checkOrders([orderId]);
        return rows[0] || { providerOrderId: String(orderId), providerStatus: 'Pending', rawResponse: null };
    }

    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[BrandOneCard] referenceId is required');
        const rows = await this._check([String(referenceId)], true);
        const row = rows.find((item) => String(item.order_uuid) === String(referenceId));
        return row ? { found: true, ...this._orderResult(row) } : { found: false };
    }

    async _recoverPlacement(referenceId) {
        try {
            const recovered = await this.checkOrderByReference(referenceId);
            if (recovered.found) return { ...recovered, success: true, errorMessage: null };
        } catch (_) { /* The fulfillment poller retries reference lookup later. */ }
        return {
            success: true, providerOrderId: null, providerStatus: 'Pending',
            outcomeUncertain: true, errorMessage: null,
            rawResponse: { order_uuid: referenceId, placement: 'uncertain' },
        };
    }

    async placeOrder(params = {}) {
        const productId = String(params.productId ?? params.externalProductId ?? params.providerProductId ?? '');
        // Use the persistent platform reference, including across adapter instances.
        // The provider recommends UUIDv4 but accepts a unique reference string.
        const referenceId = String(params.referenceId ?? params.order_uuid ?? params.orderUuid ?? params.orderId ?? '').trim();
        const quantity = Number(params.quantity ?? params.amount ?? 1);
        if (!/^\d+$/.test(productId) || Number(productId) < 1 || !referenceId
            || !Number.isSafeInteger(quantity) || quantity < 1) {
            return {
                success: false, providerOrderId: null, providerStatus: 'Cancelled',
                errorMessage: 'BrandOneCard requires a product ID, positive integer quantity and stable order reference',
                rawResponse: { validation: 'invalid_order_params' },
            };
        }
        const fields = params.params ?? params.orderFields ?? params;
        const customerFields = Object.fromEntries(Object.entries(fields).filter(([key]) => !INTERNAL_FIELDS.has(key)));
        try {
            const { data } = await this._client.get(`${API}/newOrder/${encodeURIComponent(productId)}/params`, {
                params: { ...customerFields, qty: quantity, order_uuid: referenceId },
            });
            if (data?.status === 'ERROR') {
                return {
                    success: false, providerOrderId: null, providerStatus: 'Cancelled',
                    errorCode: data.code, errorMessage: data.msg || data.detail || 'BrandOneCard rejected the order',
                    rawResponse: data,
                };
            }
            if (data?.status !== 'OK') return this._recoverPlacement(referenceId);
            return { ...this._orderResult(data.data), success: true, errorMessage: null, rawResponse: data };
        } catch (_) {
            // A timeout/HTTP 500/malformed success may follow a charged order.
            return this._recoverPlacement(referenceId);
        }
    }
}

module.exports = { BrandOneCardAdapter };

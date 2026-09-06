'use strict';

const {
    XENA_PROVIDER_SLUG,
    XENA_DYNAMIC_PRODUCT_ID,
    XENA_TARGET_FIELD_KEY,
} = require('../providers/xena.constants');
const {
    COIN_RECHARGE_PROVIDER_SLUG,
    COIN_RECHARGE_DYNAMIC_PRODUCT_ID,
    COIN_RECHARGE_TARGET_FIELD_KEY,
} = require('../providers/coinRecharge.constants');

const SENSITIVE_FIELDS = [
    'providerPrice',
    'markupType',
    'markupValue',
    'pricingMode',
    'provider',
    'providerProduct',
    'providerMapping',
    'syncPriceWithProvider',
    'enableManualPrice',
    'manualPriceAdjustment',
    'executionType',
    'createdBy',
    'deletedAt',
    'internalNotes',
    'syncedProviderBasePrice',
    'supplierId',
    'providerId',
    'externalProductId',
    'externalProductName',
    'costPrice',
    '__v',
];

const isXenaLinkedProduct = (obj = {}) => {
    const providerCode = String(obj?.provider?.slug || obj?.providerCode || '').trim().toLowerCase();
    const providerProductCode = String(obj?.providerProduct?.externalProductId || obj?.externalProductId || '').trim();
    return providerCode === XENA_PROVIDER_SLUG || providerProductCode === XENA_DYNAMIC_PRODUCT_ID;
};

const isCoinRechargeLinkedProduct = (obj = {}) => {
    const providerCode = String(obj?.provider?.slug || obj?.providerCode || '').trim().toLowerCase();
    const providerProductCode = String(obj?.providerProduct?.externalProductId || obj?.externalProductId || '').trim();
    return providerCode === COIN_RECHARGE_PROVIDER_SLUG || providerProductCode === COIN_RECHARGE_DYNAMIC_PRODUCT_ID;
};

const enrichPublicOrderField = (field = {}, { isXenaProduct = false, isCoinRechargeProduct = false } = {}) => {
    const key = String(field?.key || field?.name || field?.id || '').trim();
    if (!key) return field;

    const next = { ...field, key };
    if (isXenaProduct && key === XENA_TARGET_FIELD_KEY) {
        next.label = next.label || 'Xena ID';
        next.type = 'text';
        next.required = true;
        next.verifiable = true;
        next.validation = {
            ...(next.validation || {}),
            digitsOnly: true,
            minLength: 1,
            maxLength: 50,
        };
        next.verification = {
            ...(next.verification || {}),
            required: true,
            type: 'xena_target',
        };
    }
    if (isCoinRechargeProduct && key === COIN_RECHARGE_TARGET_FIELD_KEY) {
        next.label = next.label || 'User ID';
        next.type = 'text';
        next.required = true;
        next.verifiable = true;
        next.validation = { ...(next.validation || {}), digitsOnly: true, minLength: 1, maxLength: 50 };
        next.verification = { ...(next.verification || {}), required: true, type: 'coin_recharge_target' };
    }
    return next;
};

const enrichPublicProductContract = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const isXenaProduct = isXenaLinkedProduct(obj);
    const isCoinRechargeProduct = isCoinRechargeLinkedProduct(obj);
    if (Array.isArray(obj.orderFields)) {
        obj.orderFields = obj.orderFields.map((field) => enrichPublicOrderField(field, { isXenaProduct, isCoinRechargeProduct }));
    }
    if (isXenaProduct) {
        obj.providerCode = XENA_PROVIDER_SLUG;
    }
    if (isCoinRechargeProduct) obj.providerCode = COIN_RECHARGE_PROVIDER_SLUG;
    return obj;
};

const sanitizeProductForCustomer = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    enrichPublicProductContract(obj);
    for (const field of SENSITIVE_FIELDS) {
        delete obj[field];
    }
    return obj;
};

const sanitizeProductsForCustomer = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForCustomer);

module.exports = {
    enrichPublicProductContract,
    sanitizeProductForCustomer,
    sanitizeProductsForCustomer,
};

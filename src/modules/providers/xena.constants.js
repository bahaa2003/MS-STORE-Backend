'use strict';

const XENA_PROVIDER_SLUG = 'xena-recharge';
const XENA_PROVIDER_NAME = 'Xena Recharge';
const XENA_BASE_URL = 'https://api.digiteech.me';
const XENA_DYNAMIC_PRODUCT_ID = 'xena-dynamic-recharge';
const XENA_DYNAMIC_PRODUCT_NAME = 'Xena Dynamic Recharge (Any Amount)';
const XENA_TARGET_FIELD_KEY = 'target_uid';
const XENA_TARGET_FIELD_PROVIDER_KEY = 'targetUid';

const XENA_CONNECTION_STATUS = Object.freeze({
    PENDING: 'pending',
    VERIFICATION_REQUIRED: 'verification_required',
    CONNECTED: 'connected',
    REAUTHENTICATION_REQUIRED: 'reauthentication_required',
    DISABLED: 'disabled',
});

const XENA_RECHARGE_STATUS = Object.freeze({
    PROCESSING: 'processing',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    UNKNOWN: 'unknown',
});

module.exports = {
    XENA_PROVIDER_SLUG,
    XENA_PROVIDER_NAME,
    XENA_BASE_URL,
    XENA_DYNAMIC_PRODUCT_ID,
    XENA_DYNAMIC_PRODUCT_NAME,
    XENA_TARGET_FIELD_KEY,
    XENA_TARGET_FIELD_PROVIDER_KEY,
    XENA_CONNECTION_STATUS,
    XENA_RECHARGE_STATUS,
};

'use strict';

class ClientCompatError extends Error {
    constructor(message, code = 500, statusCode = 400) {
        super(message);
        this.name = 'ClientCompatError';
        this.compatCode = code;
        this.statusCode = statusCode;
    }
}

const ERROR_CODES = Object.freeze({
    INSUFFICIENT_BALANCE: 100, QUANTITY_NOT_AVAILABLE: 105,
    QUANTITY_NOT_ALLOWED: 106, PRODUCT_NOT_FOUND: 109,
    PRODUCT_NOT_AVAILABLE: 110, RATE_LIMITED: 111,
    QUANTITY_TOO_SMALL: 112, QUANTITY_TOO_LARGE: 113,
    ORDER_CREATE_UNKNOWN: 114, TOKEN_REQUIRED: 120, TOKEN_INVALID: 121,
    API_NOT_ALLOWED: 122, IP_FORBIDDEN: 123, VALIDATION: 124,
    MAINTENANCE: 130, INTERNAL: 500,
});

const mapErrorToCompat = (error) => {
    if (error instanceof ClientCompatError) return { statusCode: error.statusCode, code: error.compatCode, message: error.message };
    const code = String(error?.code || '').toUpperCase();
    if (code === 'INSUFFICIENT_FUNDS') return { statusCode: 422, code: 100, message: 'Insufficient balance' };
    if (['PRODUCT_INACTIVE', 'PRODUCT_UNAVAILABLE'].includes(code)) return { statusCode: 400, code: 110, message: 'Product not available now' };
    if (code === 'NOT_FOUND') return { statusCode: 404, code: 109, message: 'Product deleted or not found' };
    if (code === 'QUANTITY_NOT_AVAILABLE') return { statusCode: 400, code: 105, message: 'Quantity not available' };
    if (code === 'QUANTITY_OUT_OF_RANGE') return { statusCode: 400, code: 106, message: 'Quantity not allowed' };
    if (['INVALID_ORDER_FIELDS', 'VALIDATION', 'VALIDATION_ERROR'].includes(code)) return { statusCode: 400, code: 124, message: error.message };
    if (['ORDER_CREATE_UNKNOWN', 'ORDER_CREATION_FAILED', 'BUSINESS_RULE'].includes(code)) return { statusCode: 400, code: 114, message: error.message || 'Order could not be created' };
    return { statusCode: 500, code: 500, message: 'Unknown internal error' };
};

const sendCompatError = (res, error) => {
    const mapped = mapErrorToCompat(error);
    return res.status(mapped.statusCode).json({ status: 'ERROR', code: mapped.code, message: mapped.message });
};
const catchCompat = (handler) => async (req, res) => { try { await handler(req, res); } catch (error) { sendCompatError(res, error); } };

module.exports = { ClientCompatError, ERROR_CODES, mapErrorToCompat, sendCompatError, catchCompat };

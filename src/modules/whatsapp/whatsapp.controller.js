'use strict';

const whatsappService = require('./whatsapp.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');

const getStatus = catchAsync(async (_req, res) => {
    sendSuccess(res, whatsappService.getStatus(), 'WhatsApp status retrieved.');
});

const reconnect = catchAsync(async (_req, res) => {
    const status = await whatsappService.reconnectWhatsAppClient();
    sendSuccess(res, status, 'WhatsApp reconnect started.');
});

const reset = catchAsync(async (_req, res) => {
    const status = await whatsappService.resetWhatsAppClient();
    sendSuccess(res, status, 'WhatsApp session reset started.');
});

module.exports = {
    getStatus,
    reconnect,
    reset,
};

'use strict';
const { User, USER_STATUS } = require('../../modules/users/user.model');

const reply = (req, res, statusCode, code, message) => res.status(statusCode).json(req.clientCompatErrorFormat
    ? { status: 'ERROR', code, message }
    : { success: false, code: `RESELLER_${code}`, message });
const tokenFrom = (req) => {
    const direct = req.get('api-token') || req.get('x-api-key');
    if (direct) return String(direct).trim();
    const auth = String(req.get('authorization') || ''); return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
};
const normalizeIp = (value) => String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
module.exports = async (req, res, next) => {
    try {
        const rawToken = tokenFrom(req);
        if (!rawToken) return reply(req, res, 401, 120, 'API Token is required');
        const candidates = await User.find({ apiToken: { $exists: true, $ne: null }, deletedAt: null }).select('+apiToken name email role status walletBalance creditLimit creditUsed currency groupId isApiEnabled whitelistIps webhookUrl').populate('groupId', 'percentage isActive');
        let reseller = null;
        for (const candidate of candidates) { if (await candidate.compareApiToken(rawToken)) { reseller = candidate; break; } }
        if (!reseller) return reply(req, res, 401, 121, 'Token error');
        if (reseller.status !== USER_STATUS.ACTIVE || reseller.isApiEnabled !== true) return reply(req, res, 403, 122, 'Not allowed to use API');
        const allowed = (reseller.whitelistIps || []).map(normalizeIp).filter(Boolean);
        if (allowed.length && !allowed.includes(normalizeIp(req.ip || req.socket?.remoteAddress))) return reply(req, res, 403, 123, 'IP not allowed');
        req.reseller = reseller; req.auditContext = { actorId: reseller._id, actorRole: 'CUSTOMER', ipAddress: req.ip || null, userAgent: req.get('User-Agent') || null };
        return next();
    } catch (_) { return reply(req, res, 401, 121, 'Token error'); }
};

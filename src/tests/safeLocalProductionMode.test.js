'use strict';

const originalEnv = {
    safe: process.env.SAFE_LOCAL_PRODUCTION_MODE,
    jobs: process.env.BACKGROUND_JOBS_ENABLED,
    whatsapp: process.env.WHATSAPP_AUTO_INIT,
};
const restore = () => {
    for (const [key, value] of Object.entries({ SAFE_LOCAL_PRODUCTION_MODE: originalEnv.safe, BACKGROUND_JOBS_ENABLED: originalEnv.jobs, WHATSAPP_AUTO_INIT: originalEnv.whatsapp })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
};
const loadConfig = (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.SAFE_LOCAL_PRODUCTION_MODE;
    else process.env.SAFE_LOCAL_PRODUCTION_MODE = value;
    return require('../config/config');
};

afterEach(() => { jest.resetModules(); jest.clearAllMocks(); restore(); });
afterAll(restore);

const startWithMocks = async ({ safe = 'false', jobs, whatsapp } = {}) => {
    process.env.SAFE_LOCAL_PRODUCTION_MODE = safe;
    if (jobs === undefined) delete process.env.BACKGROUND_JOBS_ENABLED; else process.env.BACKGROUND_JOBS_ENABLED = jobs;
    if (whatsapp === undefined) delete process.env.WHATSAPP_AUTO_INIT; else process.env.WHATSAPP_AUTO_INIT = whatsapp;
    const dependencies = {
        listen: jest.fn((_port, done) => { if (done) done(); return { close: jest.fn() }; }),
        connect: jest.fn().mockResolvedValue(),
        fulfillment: { start: jest.fn(), stop: jest.fn() },
        providerSync: { start: jest.fn(), stop: jest.fn() },
        whatsapp: { initializeWhatsAppClient: jest.fn().mockResolvedValue(), destroyWhatsAppClient: jest.fn() },
    };
    jest.doMock('../app', () => ({ listen: dependencies.listen }));
    jest.doMock('../config/database', () => dependencies.connect);
    jest.doMock('../modules/orders/fulfillmentJob', () => dependencies.fulfillment);
    jest.doMock('../modules/providers/syncProvidersJob', () => dependencies.providerSync);
    jest.doMock('../modules/whatsapp/whatsapp.service', () => dependencies.whatsapp);
    const { startServer } = require('../server');
    await startServer();
    return dependencies;
};

describe('SAFE_LOCAL_PRODUCTION_MODE', () => {
    test.each([['true', true], ['false', false], ['TRUE', false], ['1', false], [undefined, false]])('only exact lowercase %p enables safe mode', (value, expected) => {
        expect(loadConfig(value).safeLocalProductionMode).toBe(expected);
    });

    test('skips implicit settings seeding only in safe mode', async () => {
        const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
        const seed = jest.fn().mockResolvedValue();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: false, seed })).toBe(true);
        await Promise.resolve();
        expect(seed).toHaveBeenCalledTimes(1);
    });

    test('safe mode starts no scheduler or WhatsApp initialization', async () => {
        const dependencies = await startWithMocks({ safe: 'true' });
        expect(dependencies.connect).toHaveBeenCalledTimes(1);
        expect(dependencies.fulfillment.start).not.toHaveBeenCalled();
        expect(dependencies.providerSync.start).not.toHaveBeenCalled();
        expect(dependencies.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('safe mode makes SMTP delivery a no-op', async () => {
        const sendMail = jest.fn().mockResolvedValue();
        const createTransport = jest.fn(() => ({ sendMail }));
        jest.doMock('nodemailer', () => ({ createTransport }));
        const config = require('../config/config'); config.env = 'development'; config.safeLocalProductionMode = true;
        const { sendEmail } = require('../services/email.service');
        await sendEmail({ to: 'safe@example.test', subject: 'safe', html: '<p>safe</p>' });
        expect(createTransport).not.toHaveBeenCalled(); expect(sendMail).not.toHaveBeenCalled();
    });

    test('safe mode makes WhatsApp initialization and admin notification no-ops', async () => {
        jest.unmock('../modules/whatsapp/whatsapp.service');
        const initialize = jest.fn().mockResolvedValue(); const sendMessage = jest.fn();
        const Client = jest.fn(() => ({ on: jest.fn(), initialize, sendMessage })); const LocalAuth = jest.fn();
        jest.doMock('whatsapp-web.js', () => ({ Client, LocalAuth }));
        const config = require('../config/config'); config.safeLocalProductionMode = true;
        const whatsapp = require('../modules/whatsapp/whatsapp.service');
        await whatsapp.initializeWhatsAppClient();
        await expect(whatsapp.sendAdminNotification('must not send')).resolves.toMatchObject({ success: true, skipped: 'SAFE_LOCAL_PRODUCTION_MODE' });
        expect(Client).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
    });

    test('normal default startup behavior remains when safe mode is false', async () => {
        const dependencies = await startWithMocks({ safe: 'false' });
        expect(dependencies.fulfillment.start).toHaveBeenCalledTimes(1);
        expect(dependencies.providerSync.start).toHaveBeenCalledTimes(1);
        expect(dependencies.whatsapp.initializeWhatsAppClient).toHaveBeenCalledTimes(1);
    });

    test('legacy flags independently disable jobs or WhatsApp auto-init', async () => {
        let dependencies = await startWithMocks({ safe: 'false', jobs: 'false' });
        expect(dependencies.fulfillment.start).not.toHaveBeenCalled(); expect(dependencies.providerSync.start).not.toHaveBeenCalled(); expect(dependencies.whatsapp.initializeWhatsAppClient).toHaveBeenCalledTimes(1);
        jest.resetModules(); jest.clearAllMocks();
        dependencies = await startWithMocks({ safe: 'false', whatsapp: 'false' });
        expect(dependencies.fulfillment.start).toHaveBeenCalledTimes(1); expect(dependencies.providerSync.start).toHaveBeenCalledTimes(1); expect(dependencies.whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });
});

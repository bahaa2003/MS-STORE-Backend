'use strict';

const fs = require('fs/promises');
const path = require('path');

let Client = null;
let LocalAuth = null;
let qrcode = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    qrcode = require('qrcode');
} catch (err) {
    dependencyLoadError = err;
}

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_AUTH_DATA_PATH = path.join(BACKEND_ROOT, '.wwebjs_auth');
const DEFAULT_CACHE_DATA_PATH = path.join(BACKEND_ROOT, '.wwebjs_cache');
const DEFAULT_CLIENT_ID = 'admin-notifications';
const DEFAULT_RECONNECT_DELAY_MS = 10000;

let client = null;
let initPromise = null;
let reconnectTimer = null;
let shouldReconnect = true;

const state = {
    isReady: false,
    isInitializing: false,
    qrDataUrl: null,
    lastError: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
};

const toIso = (date = new Date()) => date.toISOString();

const parseReconnectDelay = () => {
    const value = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RECONNECT_DELAY_MS;
};

const resolveDataPath = (value, fallback) => {
    const raw = String(value || '').trim();
    const target = raw || fallback;
    return path.isAbsolute(target) ? target : path.resolve(BACKEND_ROOT, target);
};

const getClientId = () => String(process.env.WHATSAPP_CLIENT_ID || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID;
const getAuthDataPath = () => resolveDataPath(process.env.WHATSAPP_AUTH_DATA_PATH, DEFAULT_AUTH_DATA_PATH);
const getCacheDataPath = () => resolveDataPath(process.env.WHATSAPP_CACHE_DATA_PATH, DEFAULT_CACHE_DATA_PATH);

const dependenciesAvailable = () => Boolean(Client && LocalAuth && qrcode);

const getAdminDigits = () => String(process.env.ADMIN_NOTIFICATION_NUMBER || '').replace(/\D/g, '');
const getAdminChatId = () => {
    const digits = getAdminDigits();
    if (!digits) {
        throw new Error('ADMIN_NOTIFICATION_NUMBER is not configured.');
    }
    return `${digits}@c.us`;
};

const setLastError = (err) => {
    state.lastError = err?.message || String(err || 'Unknown WhatsApp error');
};

const resetRuntimeState = () => {
    state.isReady = false;
    state.isInitializing = false;
    state.qrDataUrl = null;
};

const getStatus = () => ({
    isReady: state.isReady,
    isInitializing: state.isInitializing,
    qrDataUrl: state.qrDataUrl,
    lastError: state.lastError,
    lastConnectedAt: state.lastConnectedAt,
    lastDisconnectedAt: state.lastDisconnectedAt,
    adminNumberConfigured: Boolean(getAdminDigits()),
    dependencyAvailable: dependenciesAvailable(),
});

const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
};

const scheduleReconnect = () => {
    if (!shouldReconnect || reconnectTimer) return;

    const delayMs = parseReconnectDelay();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectWhatsAppClient().catch((err) => {
            setLastError(err);
            console.error('[WhatsApp] Reconnect failed:', err.message);
        });
    }, delayMs);

    if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
};

const bindClientEvents = (nextClient) => {
    nextClient.on('qr', async (qr) => {
        try {
            state.qrDataUrl = await qrcode.toDataURL(qr);
            state.lastError = null;
        } catch (err) {
            setLastError(err);
            console.error('[WhatsApp] Failed to generate QR data URL:', err.message);
        }
    });

    nextClient.on('authenticated', () => {
        state.lastError = null;
    });

    nextClient.on('ready', () => {
        state.isReady = true;
        state.isInitializing = false;
        state.qrDataUrl = null;
        state.lastError = null;
        state.lastConnectedAt = toIso();
        console.log('[WhatsApp] Client is ready.');
    });

    nextClient.on('auth_failure', (message) => {
        state.isReady = false;
        state.isInitializing = false;
        state.qrDataUrl = null;
        state.lastError = `Authentication failed: ${message || 'unknown reason'}`;
        console.error('[WhatsApp] Authentication failed:', message || 'unknown reason');
    });

    nextClient.on('disconnected', (reason) => {
        state.isReady = false;
        state.isInitializing = false;
        state.qrDataUrl = null;
        state.lastDisconnectedAt = toIso();
        state.lastError = reason ? `Disconnected: ${reason}` : 'Disconnected';
        console.warn('[WhatsApp] Client disconnected:', reason || 'unknown reason');
        scheduleReconnect();
    });
};

const createClient = () => {
    const options = {
        authStrategy: new LocalAuth({
            clientId: getClientId(),
            dataPath: getAuthDataPath(),
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
            ],
        },
        webVersionCache: {
            type: 'local',
            path: getCacheDataPath(),
        },
    };

    return new Client(options);
};

const initializeWhatsAppClient = async () => {
    if (!dependenciesAvailable()) {
        state.lastError = dependencyLoadError
            ? `WhatsApp dependency unavailable: ${dependencyLoadError.message}`
            : 'WhatsApp dependency unavailable.';
        console.error('[WhatsApp] Dependency unavailable:', dependencyLoadError?.message || 'unknown reason');
        return getStatus();
    }

    if (initPromise) return initPromise;
    if (client && (state.isReady || state.isInitializing)) return getStatus();

    shouldReconnect = true;
    state.isInitializing = true;
    state.isReady = false;
    state.lastError = null;

    initPromise = (async () => {
        const nextClient = createClient();
        client = nextClient;
        bindClientEvents(nextClient);

        try {
            await nextClient.initialize();
        } catch (err) {
            if (client === nextClient) {
                client = null;
            }
            resetRuntimeState();
            setLastError(err);
            console.error('[WhatsApp] Initialization failed:', err.message);
        }

        return getStatus();
    })().finally(() => {
        initPromise = null;
    });

    return initPromise;
};

const destroyCurrentClient = async () => {
    const currentClient = client;
    client = null;

    if (!currentClient) {
        resetRuntimeState();
        return;
    }

    try {
        await currentClient.destroy();
    } catch (err) {
        console.error('[WhatsApp] Client destroy failed:', err.message);
    } finally {
        resetRuntimeState();
    }
};

async function reconnectWhatsAppClient() {
    clearReconnectTimer();
    shouldReconnect = false;
    await destroyCurrentClient();
    shouldReconnect = true;
    return initializeWhatsAppClient();
}

const getSessionDirectory = () => {
    const sessionDirName = getClientId() ? `session-${getClientId()}` : 'session';
    return path.join(getAuthDataPath(), sessionDirName);
};

const removeDirectorySafely = async (targetPath, label) => {
    const resolvedPath = path.resolve(targetPath);
    const rootPath = path.parse(resolvedPath).root;

    if (!resolvedPath || resolvedPath === rootPath || resolvedPath === BACKEND_ROOT) {
        throw new Error(`Refusing to remove unsafe WhatsApp ${label} path: ${resolvedPath}`);
    }

    await fs.rm(resolvedPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
    });
};

const clearLocalSession = async () => {
    await removeDirectorySafely(getSessionDirectory(), 'auth session');

    const cachePath = getCacheDataPath();
    const cacheBaseName = path.basename(cachePath).toLowerCase();
    if (cacheBaseName.includes('wwebjs') || cacheBaseName.includes('whatsapp')) {
        await removeDirectorySafely(cachePath, 'cache');
    }
};

async function resetWhatsAppClient() {
    clearReconnectTimer();
    shouldReconnect = false;

    if (client && state.isReady && typeof client.logout === 'function') {
        try {
            await client.logout();
        } catch (err) {
            console.warn('[WhatsApp] Logout before reset failed:', err.message);
        }
    }

    await destroyCurrentClient();

    try {
        await clearLocalSession();
        state.lastError = null;
    } catch (err) {
        setLastError(err);
        console.error('[WhatsApp] Reset cleanup failed:', err.message);
    }

    shouldReconnect = true;
    return initializeWhatsAppClient();
}

async function destroyWhatsAppClient() {
    clearReconnectTimer();
    shouldReconnect = false;
    await destroyCurrentClient();
    return getStatus();
}

const formatMetadataForLog = (metadata) => {
    if (!metadata || typeof metadata !== 'object') return '';
    try {
        return JSON.stringify(metadata);
    } catch (_) {
        return '[unserializable metadata]';
    }
};

async function sendAdminNotification(message, metadata = {}) {
    try {
        if (!dependenciesAvailable()) {
            throw new Error(state.lastError || 'WhatsApp dependency unavailable.');
        }

        const text = String(message || '').trim();
        if (!text) {
            throw new Error('WhatsApp admin notification message is empty.');
        }

        if (!client || !state.isReady) {
            throw new Error('WhatsApp client is not ready.');
        }

        const chatId = getAdminChatId();
        const result = await client.sendMessage(chatId, text);

        return {
            success: true,
            messageId: result?.id?._serialized || null,
        };
    } catch (err) {
        const metadataText = formatMetadataForLog(metadata);
        console.error(
            '[WhatsApp] Admin notification failed:',
            err.message,
            metadataText ? `metadata=${metadataText}` : ''
        );
        return {
            success: false,
            error: err.message,
        };
    }
}

module.exports = {
    initializeWhatsAppClient,
    reconnectWhatsAppClient,
    resetWhatsAppClient,
    destroyWhatsAppClient,
    getStatus,
    sendAdminNotification,
};

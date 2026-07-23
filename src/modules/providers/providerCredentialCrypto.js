'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1';

const getSecret = () => (
    process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY
    || process.env.PROVIDER_CREDENTIALS_KEY
    || process.env.JWT_SECRET
    || 'development-provider-credential-key'
);

const getKey = () => crypto.createHash('sha256').update(String(getSecret())).digest();

const isEncrypted = (value) => (
    typeof value === 'string'
    && value.startsWith(`${PREFIX}:`)
);

const encryptCredential = (value) => {
    if (value === undefined || value === null || value === '') return value;
    const plain = String(value);
    if (isEncrypted(plain)) return plain;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        PREFIX,
        iv.toString('base64url'),
        tag.toString('base64url'),
        encrypted.toString('base64url'),
    ].join(':');
};

const decryptCredential = (value) => {
    if (value === undefined || value === null || value === '') return value;
    const raw = String(value);
    if (!isEncrypted(raw)) return raw;

    const [, , ivB64, tagB64, encryptedB64] = raw.split(':');
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getKey(),
        Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedB64, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
};

const redactSecret = (value) => {
    if (!value) return null;
    return '[REDACTED]';
};

module.exports = {
    encryptCredential,
    decryptCredential,
    isEncrypted,
    redactSecret,
};

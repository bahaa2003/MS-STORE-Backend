'use strict';

const mongoose = require('mongoose');
const {
    encryptCredential,
    decryptCredential,
} = require('./providerCredentialCrypto');

const XENA_CONNECTION_STATUSES = Object.freeze([
    'pending',
    'verification_required',
    'connected',
    'reauthentication_required',
    'disabled',
]);

/**
 * Provider — an external data source that supplies raw product inventory.
 *
 * Layer 1 of the 3-layer architecture:
 *   Provider → ProviderProduct → Product
 *
 * Each provider has its own HTTP API adapter. The sync engine calls the
 * adapter and writes raw data into ProviderProducts. Admins then
 * cherry-pick which raw products to expose as platform Products.
 */
const providerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Provider name is required'],
            trim: true,
            unique: true,
            minlength: [2, 'Provider name must be at least 2 characters'],
            maxlength: [100, 'Provider name cannot exceed 100 characters'],
        },

        /**
         * URL-safe identifier, e.g. "royal-crown".
         * Auto-generated from name if not supplied.
         * Used as adapter registry key.
         */
        slug: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
            lowercase: true,
        },

        /**
         * Base URL of the provider's API.
         * The adapter uses this as the root for all HTTP calls.
         */
        baseUrl: {
            type: String,
            required: [true, 'baseUrl is required'],
            trim: true,
        },

        /**
         * Primary API token / key for this provider.
         * Stored in plain text — use env vars for production secrets.
         * Aliased as apiKey for backward compatibility with existing code.
         */
        apiToken: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * @deprecated — kept for backward compatibility, maps to apiToken.
         */
        apiKey: {
            type: String,
            trim: true,
            default: null,
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        /**
         * How often (in minutes) the scheduler should sync this provider.
         * 0 = never sync automatically (manual-only).
         */
        syncInterval: {
            type: Number,
            default: 60,
            min: [0, 'syncInterval cannot be negative'],
        },

        /**
         * List of feature strings this provider supports.
         * Examples: ['placeOrder', 'checkOrder', 'checkOrdersBatch', 'fetchProducts']
         * Used by the adapter factory to validate capabilities before calling.
         */
        supportedFeatures: {
            type: [String],
            default: [],
        },

        xenaConfig: {
            connectionId: { type: String, trim: true, default: null },
            connectionStatus: {
                type: String,
                enum: XENA_CONNECTION_STATUSES,
                default: 'pending',
            },
            connectionExpiresAt: { type: Date, default: null },
            tokenExpiresAt: { type: Date, default: null },
            displayName: {
                type: String,
                trim: true,
                default: null,
                maxlength: [100, 'Xena displayName cannot exceed 100 characters'],
            },
            maskedUsername: {
                type: String,
                trim: true,
                default: null,
                maxlength: [200, 'Xena maskedUsername cannot exceed 200 characters'],
            },
            lastErrorCode: {
                type: String,
                trim: true,
                default: null,
                maxlength: [100, 'Xena lastErrorCode cannot exceed 100 characters'],
            },
            lastErrorMessage: {
                type: String,
                trim: true,
                default: null,
                maxlength: [500, 'Xena lastErrorMessage cannot exceed 500 characters'],
            },
            lastCheckedAt: { type: Date, default: null },
            product: {
                externalProductId: {
                    type: String,
                    trim: true,
                    default: 'xena-dynamic-recharge',
                },
                name: {
                    type: String,
                    trim: true,
                    default: 'Xena Dynamic Recharge (Any Amount)',
                    maxlength: [200, 'Xena product name cannot exceed 200 characters'],
                },
                unitPrice: {
                    type: String,
                    default: null,
                    get: (v) => v != null ? String(v) : null,
                    set: (v) => v != null && v !== '' ? String(v) : null,
                },
                minAmount: {
                    type: Number,
                    default: null,
                    validate: {
                        validator: (v) => v == null || (Number.isSafeInteger(v) && v > 0),
                        message: 'Xena minAmount must be a positive safe integer',
                    },
                },
                maxAmount: {
                    type: Number,
                    default: null,
                    validate: {
                        validator: function (v) {
                            if (v == null) return true;
                            if (!Number.isSafeInteger(v) || v <= 0) return false;
                            const min = this?.xenaConfig?.product?.minAmount;
                            return min == null || v >= min;
                        },
                        message: 'Xena maxAmount must be a positive safe integer >= minAmount',
                    },
                },
                isActive: { type: Boolean, default: false },
            },
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// ─── Virtuals ──────────────────────────────────────────────────────────────────

/**
 * effectiveToken — resolves apiToken → apiKey for backward compatibility.
 * Always use this in adapters instead of reading either field directly.
 */
providerSchema.virtual('effectiveToken').get(function () {
    const token = this.apiToken || this.apiKey || null;
    return token ? decryptCredential(token) : null;
});

const encryptProviderSecrets = function () {
    if (this.isModified('apiToken') && this.apiToken) {
        this.apiToken = encryptCredential(this.apiToken);
    }
    if (this.isModified('apiKey') && this.apiKey) {
        this.apiKey = encryptCredential(this.apiKey);
    }
};

// ─── Pre-save: auto-generate slug ───────────────────────────────────────────────

providerSchema.pre('save', function (next) {
    if (!this.slug && this.name) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }
    encryptProviderSecrets.call(this);
    next();
});

providerSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate() || {};
    const target = update.$set || update;

    if (Object.prototype.hasOwnProperty.call(target, 'apiToken') && target.apiToken) {
        target.apiToken = encryptCredential(target.apiToken);
    }
    if (Object.prototype.hasOwnProperty.call(target, 'apiKey') && target.apiKey) {
        target.apiKey = encryptCredential(target.apiKey);
    }

    if (update.$set) update.$set = target;
    else this.setUpdate(target);
    next();
});

const stripProviderSecrets = (_doc, ret) => {
    const hasCredential = Boolean(ret.apiToken || ret.apiKey);
    delete ret.apiToken;
    delete ret.apiKey;
    delete ret.effectiveToken;
    ret.credentialsConfigured = hasCredential;
    return ret;
};

providerSchema.set('toJSON', {
    virtuals: true,
    transform: stripProviderSecrets,
});

providerSchema.set('toObject', {
    virtuals: true,
    transform: stripProviderSecrets,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

providerSchema.index({ isActive: 1 });

const Provider = mongoose.model('Provider', providerSchema);

module.exports = { Provider };

'use strict';

const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const INDEX_NAME = 'unique_user_idempotency_key';
const INDEX_KEY = { userId: 1, idempotencyKey: 1 };
const PARTIAL_FILTER = {
    idempotencyKey: {
        $type: 'string',
        $gt: '',
    },
};

const stableStringify = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const sameDocument = (a, b) => stableStringify(a || {}) === stableStringify(b || {});

const safeIndexInfo = (index) => ({
    name: index.name,
    key: index.key,
    unique: index.unique === true,
    sparse: index.sparse === true,
    partialFilterExpression: index.partialFilterExpression || null,
});

const isCorrectIndex = (index) => (
    index
    && index.unique === true
    && index.sparse !== true
    && sameDocument(index.key, INDEX_KEY)
    && sameDocument(index.partialFilterExpression, PARTIAL_FILTER)
);

const hashKey = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

const findMeaningfulDuplicateKeys = async (collection) => collection.aggregate([
    {
        $match: {
            idempotencyKey: { $type: 'string', $gt: '' },
        },
    },
    {
        $group: {
            _id: { userId: '$userId', idempotencyKey: '$idempotencyKey' },
            count: { $sum: 1 },
            orderIds: { $push: '$_id' },
        },
    },
    { $match: { count: { $gt: 1 } } },
    {
        $project: {
            _id: 0,
            userId: '$_id.userId',
            idempotencyKey: '$_id.idempotencyKey',
            count: 1,
            orderIds: { $slice: ['$orderIds', 5] },
        },
    },
]).toArray();

const maskDuplicate = (dup) => ({
    userId: dup.userId?.toString?.() || String(dup.userId),
    idempotencyKeyHash: hashKey(dup.idempotencyKey),
    count: dup.count,
    sampleOrderIds: (dup.orderIds || []).map((id) => id?.toString?.() || String(id)),
});

const ensureOrderIdempotencyIndex = async ({ db, dryRun = false, logger = console } = {}) => {
    if (!db) throw new Error('A MongoDB database handle is required.');

    const collection = db.collection('orders');
    const indexes = await collection.indexes();
    logger.log('[OrderIdempotencyIndex] Existing indexes:', indexes.map(safeIndexInfo));

    const duplicates = await findMeaningfulDuplicateKeys(collection);
    if (duplicates.length > 0) {
        const err = new Error('Cannot create idempotency index: duplicated meaningful idempotency keys exist.');
        err.code = 'ORDER_IDEMPOTENCY_INDEX_CONFLICTS';
        err.conflicts = duplicates.map(maskDuplicate);
        logger.error('[OrderIdempotencyIndex] Conflicts:', err.conflicts);
        throw err;
    }

    const existing = indexes.find((index) => index.name === INDEX_NAME);
    if (isCorrectIndex(existing)) {
        logger.log('[OrderIdempotencyIndex] Index already correct.');
        return { changed: false, dryRun, index: safeIndexInfo(existing) };
    }

    if (existing) {
        logger.log('[OrderIdempotencyIndex] Incorrect named index detected:', safeIndexInfo(existing));
        if (dryRun) {
            logger.log(`[OrderIdempotencyIndex] DRY RUN: would drop index ${INDEX_NAME}.`);
        } else {
            await collection.dropIndex(INDEX_NAME);
            logger.log(`[OrderIdempotencyIndex] Dropped index ${INDEX_NAME}.`);
        }
    }

    if (dryRun) {
        logger.log('[OrderIdempotencyIndex] DRY RUN: would create partial unique index.', {
            key: INDEX_KEY,
            unique: true,
            partialFilterExpression: PARTIAL_FILTER,
        });
        return { changed: true, dryRun, index: null };
    }

    await collection.createIndex(INDEX_KEY, {
        unique: true,
        name: INDEX_NAME,
        partialFilterExpression: PARTIAL_FILTER,
    });

    const verified = (await collection.indexes()).find((index) => index.name === INDEX_NAME);
    if (!isCorrectIndex(verified)) {
        throw new Error('Failed to verify replacement idempotency index.');
    }

    logger.log('[OrderIdempotencyIndex] Replacement index verified:', safeIndexInfo(verified));
    return { changed: true, dryRun, index: safeIndexInfo(verified) };
};

const rollbackOrderIdempotencyIndex = async ({
    db,
    dryRun = false,
    recreateOldSparse = false,
    logger = console,
} = {}) => {
    if (!db) throw new Error('A MongoDB database handle is required.');

    const collection = db.collection('orders');
    const indexes = await collection.indexes();
    const existing = indexes.find((index) => index.name === INDEX_NAME);

    if (existing) {
        logger.warn('[OrderIdempotencyIndex] Rollback will drop only the named idempotency index:', safeIndexInfo(existing));
        if (!dryRun) await collection.dropIndex(INDEX_NAME);
    }

    if (recreateOldSparse) {
        logger.warn('[OrderIdempotencyIndex] Recreating the old sparse index restores the production defect. Use only for emergency rollback.');
        if (!dryRun) {
            await collection.createIndex(INDEX_KEY, {
                unique: true,
                sparse: true,
                name: INDEX_NAME,
            });
        }
    }

    return { changed: Boolean(existing) || recreateOldSparse, dryRun, recreatedOldSparse: Boolean(recreateOldSparse) };
};

const connectFromBackendConfig = async () => {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
    const config = require('../../src/config/config');
    if (!config.db.uri) throw new Error('MONGO_URI is required.');
    await mongoose.connect(config.db.uri);
    return mongoose.connection.db;
};

const main = async () => {
    const args = new Set(process.argv.slice(2));
    const dryRun = args.has('--dry-run');
    const rollback = args.has('--rollback');
    const recreateOldSparse = args.has('--recreate-old-sparse');

    try {
        const db = await connectFromBackendConfig();
        if (rollback) {
            await rollbackOrderIdempotencyIndex({ db, dryRun, recreateOldSparse });
        } else {
            await ensureOrderIdempotencyIndex({ db, dryRun });
        }
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('[OrderIdempotencyIndex] Migration failed:', err.code || err.message);
        if (err.conflicts) console.error('[OrderIdempotencyIndex] Safe conflicts:', err.conflicts);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    }
};

if (require.main === module) {
    main();
}

module.exports = {
    INDEX_NAME,
    INDEX_KEY,
    PARTIAL_FILTER,
    isCorrectIndex,
    ensureOrderIdempotencyIndex,
    rollbackOrderIdempotencyIndex,
};

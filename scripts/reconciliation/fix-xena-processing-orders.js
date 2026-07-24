'use strict';

const path = require('path');
const mongoose = require('mongoose');
const { extractXenaRechargeId } = require('../../src/modules/providers/adapters/xena.adapter');
const { XENA_PROVIDER_SLUG } = require('../../src/modules/providers/xena.constants');

const XENA_RECHARGE_ID_MISSING = 'XENA_RECHARGE_ID_MISSING';
const PROCESSING = 'PROCESSING';
const MANUAL_REVIEW = 'MANUAL_REVIEW';

const safeRawShape = (raw) => {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const data = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? obj.data : null;
    return {
        topLevelKeys: Object.keys(obj).sort(),
        dataKeys: data ? Object.keys(data).sort() : null,
        status: obj.status ?? data?.status ?? null,
        hasRequestId: obj.requestId !== undefined || data?.requestId !== undefined,
    };
};

const inspectXenaProcessingOrders = async ({ db, apply = false, logger = console } = {}) => {
    if (!db) throw new Error('A MongoDB database handle is required.');

    const collection = db.collection('orders');
    const orders = await collection.find({
        providerCode: XENA_PROVIDER_SLUG,
        status: PROCESSING,
        $or: [
            { providerOrderId: null },
            { providerOrderId: { $exists: false } },
            { providerOrderId: '' },
        ],
    }, {
        projection: {
            _id: 1,
            orderNumber: 1,
            providerCode: 1,
            providerOrderId: 1,
            providerRequestId: 1,
            providerStatus: 1,
            providerOutcome: 1,
            providerRawResponse: 1,
        },
        sort: { createdAt: 1, _id: 1 },
    }).toArray();

    const summary = {
        scanned: orders.length,
        backfillable: 0,
        manualReview: 0,
        modified: 0,
        dryRun: !apply,
        actions: [],
    };

    for (const order of orders) {
        const recoveredId = extractXenaRechargeId(order.providerRawResponse);
        const action = {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber ?? null,
            providerCode: order.providerCode,
            providerStatus: order.providerStatus ?? null,
            providerOutcome: order.providerOutcome ?? null,
            requestIdPresent: Boolean(order.providerRequestId),
            rawShape: safeRawShape(order.providerRawResponse),
            action: recoveredId ? 'backfill_providerOrderId' : 'manual_review_missing_recharge_id',
        };

        summary.actions.push(action);
        logger.log('[XenaProcessingReconciliation]', action);

        if (recoveredId) {
            summary.backfillable++;
            if (apply) {
                const result = await collection.updateOne(
                    {
                        _id: order._id,
                        status: PROCESSING,
                        providerCode: XENA_PROVIDER_SLUG,
                        $or: [
                            { providerOrderId: null },
                            { providerOrderId: { $exists: false } },
                            { providerOrderId: '' },
                        ],
                    },
                    {
                        $set: {
                            providerOrderId: recoveredId,
                            providerErrorCode: null,
                            updatedAt: new Date(),
                        },
                    }
                );
                summary.modified += result.modifiedCount;
            }
            continue;
        }

        summary.manualReview++;
        if (apply) {
            const result = await collection.updateOne(
                {
                    _id: order._id,
                    status: PROCESSING,
                    providerCode: XENA_PROVIDER_SLUG,
                    $or: [
                        { providerOrderId: null },
                        { providerOrderId: { $exists: false } },
                        { providerOrderId: '' },
                    ],
                },
                {
                    $set: {
                        status: MANUAL_REVIEW,
                        providerOutcome: 'uncertain',
                        providerErrorCode: XENA_RECHARGE_ID_MISSING,
                        lastCheckedAt: new Date(),
                        updatedAt: new Date(),
                    },
                }
            );
            summary.modified += result.modifiedCount;
        }
    }

    logger.log('[XenaProcessingReconciliation] Summary:', {
        scanned: summary.scanned,
        backfillable: summary.backfillable,
        manualReview: summary.manualReview,
        modified: summary.modified,
        dryRun: summary.dryRun,
    });

    return summary;
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
    const apply = args.has('--apply') || args.has('--no-dry-run');

    try {
        const db = await connectFromBackendConfig();
        await inspectXenaProcessingOrders({ db, apply });
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('[XenaProcessingReconciliation] Failed:', err.code || err.message);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    }
};

if (require.main === module) {
    main();
}

module.exports = {
    XENA_RECHARGE_ID_MISSING,
    inspectXenaProcessingOrders,
    safeRawShape,
};

'use strict';

jest.mock('../modules/notifications/notification.service', () => ({
    notifyTargetApproved: jest.fn(),
    notifyTargetRejected: jest.fn(),
}));

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
} = require('./testHelpers');
const targetSvc = require('../modules/targets/target.service');
const { TargetOrder, TARGET_ORDER_STATUS } = require('../modules/targets/target.model');

describe('Target app purchasing', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);
    beforeEach(clearCollections);

    test('creates target orders from an active app and snapshots app pricing', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1.25,
            allowedPaymentMethods: ['Vodafone Cash', 'InstaPay'],
            image: 'uploads/target-apps/tiktok.png',
        });

        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-123',
            transferNumber: '01000000000',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/proof.png',
        });

        expect(order.appId.toString()).toBe(app._id.toString());
        expect(order.appNameSnapshot).toBe('TikTok Coins');
        expect(order.unitPriceSnapshot).toBe(1.25);
        expect(order.totalPrice).toBe(12.5);
        expect(order.transferNumber).toBe('01000000000');
        expect(order.paymentMethod).toBe('InstaPay');
    });

    test('rejects payment methods not allowed by the selected app', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'PUBG Mobile',
            unitPrice: 2,
            allowedPaymentMethods: ['Binance'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-456',
            transferNumber: '01000000001',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'PAYMENT_METHOD_NOT_ALLOWED' });
    });

    test('deactivates target apps and hides them from customer app lists', async () => {
        const activeApp = await targetSvc.createTargetApp({
            name: 'Active App',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const inactiveApp = await targetSvc.createTargetApp({
            name: 'Inactive App',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });

        await targetSvc.deactivateTargetApp(inactiveApp._id);

        const customerApps = await targetSvc.listTargetApps({ includeInactive: false });
        const adminApps = await targetSvc.listTargetApps({ includeInactive: true });

        expect(customerApps.map((app) => app._id.toString())).toEqual([activeApp._id.toString()]);
        expect(adminApps).toHaveLength(2);
    });

    test('keeps admin review compare-and-swap behavior', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1,
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-789',
            transferNumber: '01000000002',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        });

        await targetSvc.approveTargetOrder(order._id, admin._id);
        await expect(targetSvc.rejectTargetOrder(order._id, admin._id)).rejects.toMatchObject({
            code: 'TARGET_ORDER_ALREADY_APPROVED',
        });

        const reviewed = await TargetOrder.findById(order._id);
        expect(reviewed.status).toBe(TARGET_ORDER_STATUS.APPROVED);
    });
});

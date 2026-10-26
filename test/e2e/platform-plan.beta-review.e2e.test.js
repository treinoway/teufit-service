import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { createTrainerWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import * as asaasClient from '../../src/billing/asaas-client.js';

vi.mock('../../src/billing/asaas-client.js', () => ({
  createCustomer: vi.fn().mockResolvedValue({ id: 'mock-asaas-cust-001' }),
  getCustomer: vi.fn().mockResolvedValue({ id: 'mock-asaas-cust-001' }),
  createSubscription: vi.fn().mockResolvedValue({ id: 'mock-asaas-sub-001', invoiceUrl: 'https://pay', qrCode: null }),
  updateSubscription: vi.fn().mockResolvedValue({ id: 'mock-asaas-sub-001' }),
  cancelSubscriptionAtNextCycle: vi.fn().mockResolvedValue({ id: 'mock-asaas-sub-001' }),
  deleteSubscription: vi.fn().mockResolvedValue({}),
  getSubscription: vi.fn().mockResolvedValue({ id: 'mock-asaas-sub-001' }),
  getPayment: vi.fn().mockResolvedValue({ id: 'mock-pay-001' }),
  listPaymentsBySubscription: vi.fn().mockResolvedValue({ data: [] }),
}));

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const WEBHOOK_SECRET = 'test-webhook-secret-123';
const ASAAS_SUBSCRIPTION_ID = 'mock-asaas-sub-001';
const BETA_TIER = 'BETA';
const NO_PAID_SUBSCRIPTION_ERROR = 'PLATFORM_PLAN_NO_PAID_SUBSCRIPTION';

e2eDescribe('e2e: BETA plan review fixes', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    asaasClient.createCustomer.mockResolvedValue({ id: 'mock-asaas-cust-001' });
    asaasClient.getCustomer.mockResolvedValue({ id: 'mock-asaas-cust-001' });
    asaasClient.createSubscription.mockResolvedValue({ id: ASAAS_SUBSCRIPTION_ID, invoiceUrl: 'https://pay', qrCode: null });
    asaasClient.updateSubscription.mockResolvedValue({ id: ASAAS_SUBSCRIPTION_ID });
    asaasClient.cancelSubscriptionAtNextCycle.mockResolvedValue({ id: ASAAS_SUBSCRIPTION_ID });
  });

  function authHeader(accessToken, extra = {}) {
    return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...extra };
  }

  function post(url, accessToken, payload) {
    return app.inject({ method: 'POST', url, headers: authHeader(accessToken), payload });
  }

  async function startCheckout(accessToken) {
    const res = await post('/trainer/platform-plan/checkout', accessToken, { tier: 'PRO', billingType: 'PIX' });
    expect(res.statusCode).toBe(200);
  }

  function sendWebhook(payload) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: { 'content-type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
      payload,
    });
  }

  function confirmPayment(trainerId, tier) {
    return sendWebhook({
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_review_001',
        subscription: ASAAS_SUBSCRIPTION_ID,
        value: 49.9,
        dueDate: '2026-05-16',
        billingType: 'PIX',
        externalReference: `tier:${tier}:trainer:${trainerId}`,
      },
    });
  }

  describe.each(['FREE', BETA_TIER])('%s trainer with an unpaid checkout', (startingTier) => {
    it('should not be able to change tier before paying', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, startingTier);
      await startCheckout(accessToken);

      const res = await post('/trainer/platform-plan/change', accessToken, { tier: 'DIAMOND' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: NO_PAID_SUBSCRIPTION_ERROR, messageCode: 'resource.conflict' });
      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(subscription.tier).toBe(startingTier);
    });

    it('should not be able to cancel before paying', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, startingTier);
      await startCheckout(accessToken);

      const res = await post('/trainer/platform-plan/cancel', accessToken);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(NO_PAID_SUBSCRIPTION_ERROR);
    });

    it('should be able to change tier once the payment is confirmed', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, startingTier);
      await startCheckout(accessToken);
      await confirmPayment(trainerId, 'PRO');

      const res = await post('/trainer/platform-plan/change', accessToken, { tier: 'DIAMOND' });

      expect(res.statusCode).toBe(200);
      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(subscription).toMatchObject({ tier: 'DIAMOND', checkoutPendingSince: null });
    });
  });

  describe('BETA trainer who abandons a checkout', () => {
    it('should keep BETA after PAYMENT_OVERDUE and drop the Asaas link', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);
      await startCheckout(accessToken);

      await sendWebhook({
        event: 'PAYMENT_OVERDUE',
        payment: { id: 'pay_review_002', subscription: ASAAS_SUBSCRIPTION_ID, value: 49.9, dueDate: '2026-05-16' },
      });

      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(subscription).toMatchObject({ tier: BETA_TIER, status: 'ACTIVE', asaasSubscriptionId: null, pastDueSince: null });
    });

    it('should keep BETA after SUBSCRIPTION_DELETED', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);
      await startCheckout(accessToken);

      await sendWebhook({ event: 'SUBSCRIPTION_DELETED', subscription: { id: ASAAS_SUBSCRIPTION_ID } });

      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(subscription).toMatchObject({ tier: BETA_TIER, status: 'ACTIVE', asaasSubscriptionId: null });
    });
  });

  describe('cancel route content-type handling', () => {
    it('should still reject a malformed JSON body sent with a content-length', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, 'PRO');

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/platform-plan/cancel',
        headers: authHeader(accessToken),
        payload: '{not-json',
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { createTrainerWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
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

const BETA_TIER = 'BETA';
const NO_PAID_SUBSCRIPTION_ERROR = 'PLATFORM_PLAN_NO_PAID_SUBSCRIPTION';
const CONFLICT_MESSAGE_CODE = 'resource.conflict';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;

e2eDescribe('e2e: BETA platform plan', () => {
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
  });

  function authHeader(accessToken) {
    return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  }

  function post(url, accessToken, payload) {
    return app.inject({ method: 'POST', url, headers: authHeader(accessToken), payload });
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
    expect(body).toHaveProperty('details');
  }

  function expectNoAsaasCalls() {
    Object.values(asaasClient).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  }

  describe('GET /trainer/platform-plan for a BETA trainer', () => {
    it('should return tier BETA with DIAMOND-equivalent limits', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);

      const res = await app.inject({ method: 'GET', url: '/trainer/platform-plan', headers: authHeader(accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        tier: BETA_TIER,
        limits: {
          studentCap: null,
          aiActionsPerStudent: null,
          aiActionsTrainerCap: 1000,
          branding: true,
          championships: true,
        },
      });
    });

    it('should expose tier BETA in GET /me platformPlan', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);

      const res = await app.inject({ method: 'GET', url: '/me', headers: authHeader(accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json().platformPlan.tier).toBe(BETA_TIER);
    });
  });

  describe('BETA is never purchasable', () => {
    it('should answer 400 validation.failed on checkout with tier BETA and not call Asaas', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const res = await post('/trainer/platform-plan/checkout', accessToken, { tier: BETA_TIER, billingType: 'PIX' });

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expectNoAsaasCalls();
    });

    it('should answer 400 validation.failed on change with tier BETA and not call Asaas', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const res = await post('/trainer/platform-plan/change', accessToken, { tier: BETA_TIER });

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expectNoAsaasCalls();
    });
  });

  describe('change and cancel without a paid subscription', () => {
    it('should answer 409 PLATFORM_PLAN_NO_PAID_SUBSCRIPTION on change for a BETA trainer', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);

      const res = await post('/trainer/platform-plan/change', accessToken, { tier: PRO });

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: NO_PAID_SUBSCRIPTION_ERROR, messageCode: CONFLICT_MESSAGE_CODE });
    });

    it('should keep the BETA tier after a rejected change', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);

      await post('/trainer/platform-plan/change', accessToken, { tier: PRO });

      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(subscription.tier).toBe(BETA_TIER);
    });

    it('should answer 409 PLATFORM_PLAN_NO_PAID_SUBSCRIPTION on cancel for a BETA trainer', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, BETA_TIER);

      const res = await post('/trainer/platform-plan/cancel', accessToken);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: NO_PAID_SUBSCRIPTION_ERROR, messageCode: CONFLICT_MESSAGE_CODE });
    });

    it('should block a FREE row without Asaas subscription from self-granting a paid tier', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, FREE);

      const res = await post('/trainer/platform-plan/change', accessToken, { tier: PRO });

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: NO_PAID_SUBSCRIPTION_ERROR, messageCode: CONFLICT_MESSAGE_CODE });
    });
  });
});

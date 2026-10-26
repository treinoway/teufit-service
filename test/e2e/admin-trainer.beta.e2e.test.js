import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { createAdminWithToken, createTrainerWithToken, linkStudents } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import * as asaasClient from '../../src/billing/asaas-client.js';

vi.mock('../../src/billing/asaas-client.js', () => ({
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  createSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  cancelSubscriptionAtNextCycle: vi.fn(),
  deleteSubscription: vi.fn(),
  getSubscription: vi.fn(),
  getPayment: vi.fn(),
  listPaymentsBySubscription: vi.fn(),
}));

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const BETA_TIER = 'BETA';
const BETA_WITH_PAID_ERROR = 'PLATFORM_PLAN_BETA_WITH_PAID_SUBSCRIPTION';
const CONFLICT_MESSAGE_CODE = 'resource.conflict';
const ASAAS_SUBSCRIPTION_ID = 'mock-asaas-sub-001';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;

e2eDescribe('e2e: admin sets the BETA plan', () => {
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

  function patchPlan(accessToken, trainerId, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/admin/trainers/${trainerId}/platform-plan`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
  }

  it('should set BETA on a FREE trainer and reactivate blocked students', async () => {
    const { accessToken } = await createAdminWithToken(app);
    const { trainerId } = await createTrainerWithToken(app);
    await provisionTrainerPlan(trainerId, FREE);
    await linkStudents(app, trainerId, { count: 5, blockedCount: 2 });

    const res = await patchPlan(accessToken, trainerId, { tier: BETA_TIER });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ previousTier: FREE, tier: BETA_TIER, changed: true, studentCap: null });
    const blocked = await prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: false } });
    expect(blocked).toBe(0);
  });

  it('should answer 409 PLATFORM_PLAN_BETA_WITH_PAID_SUBSCRIPTION when the trainer has an Asaas subscription', async () => {
    const { accessToken } = await createAdminWithToken(app);
    const { trainerId } = await createTrainerWithToken(app);
    await prisma.platformSubscription.create({
      data: { trainerId, tier: PRO, status: 'ACTIVE', asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID },
    });

    const res = await patchPlan(accessToken, trainerId, { tier: BETA_TIER });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: BETA_WITH_PAID_ERROR,
      messageCode: CONFLICT_MESSAGE_CODE,
      message: expect.any(String),
    });
    expect(res.json()).toHaveProperty('details');
  });

  it('should keep the tier and not call Asaas when BETA is rejected', async () => {
    const { accessToken } = await createAdminWithToken(app);
    const { trainerId } = await createTrainerWithToken(app);
    await prisma.platformSubscription.create({
      data: { trainerId, tier: PRO, status: 'ACTIVE', asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID },
    });

    await patchPlan(accessToken, trainerId, { tier: BETA_TIER });

    const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId } });
    expect(subscription.tier).toBe(PRO);
    Object.values(asaasClient).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
});

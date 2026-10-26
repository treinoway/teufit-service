import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
  linkStudents,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import {
  PLAN_LIMITS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';
import * as asaasClient from '../../src/billing/asaas-client.js';

// Admin overrides must never reach Asaas — mock the client and assert it stays untouched
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

const { FREE, PRO, PLATINUM, DIAMOND } = PLATFORM_PLAN_TIERS;
const UNKNOWN_TRAINER_ID = '00000000-0000-4000-8000-000000000000';
const FORBIDDEN_STATUS = 403;
const UNAUTHORIZED_STATUS = 401;

e2eDescribe('e2e: admin trainer plan management', () => {
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
    return { authorization: `Bearer ${accessToken}` };
  }

  function listTrainers(accessToken, query = '') {
    return app.inject({
      method: 'GET',
      url: `/admin/trainers${query}`,
      headers: accessToken ? authHeader(accessToken) : {},
    });
  }

  function patchPlan(accessToken, trainerId, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/admin/trainers/${trainerId}/platform-plan`,
      headers: accessToken ? authHeader(accessToken) : {},
      payload,
    });
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toMatchObject({
      error,
      messageCode,
      message: expect.any(String),
    });
    expect(body).toHaveProperty('details');
  }

  function expectNoAsaasCalls() {
    Object.values(asaasClient).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  }

  describe('access control', () => {
    it('GET /admin/trainers returns 401 without a token', async () => {
      const response = await listTrainers(null);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });

    it('GET /admin/trainers returns 403 auth.forbidden to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await listTrainers(accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('GET /admin/trainers returns 403 to a student', async () => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await listTrainers(accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
    });

    it('PATCH /admin/trainers/:trainerId/platform-plan returns 401 without a token', async () => {
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(null, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });

    it('PATCH /admin/trainers/:trainerId/platform-plan returns 403 auth.forbidden to a trainer', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);

      const response = await patchPlan(accessToken, trainerId, { tier: DIAMOND });

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('a trainer cannot self-upgrade through the admin endpoint (no plan change persisted)', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken(app);

      await patchPlan(accessToken, trainerId, { tier: DIAMOND });

      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row).toBeNull();
    });
  });

  describe('GET /admin/trainers', () => {
    it('lists a trainer without a subscription row as FREE with the FREE cap', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId, userId } = await createTrainerWithToken(app);

      const response = await listTrainers(adminToken);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(body.items[0]).toMatchObject({
        trainerId,
        userId,
        tier: FREE,
        subscriptionStatus: null,
        hasAsaasSubscription: false,
        activeStudents: 0,
        studentCap: PLAN_LIMITS.FREE.studentCap,
      });
    });

    it('returns name and email of the trainer user', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { email } = await createTrainerWithToken(app, { firstName: 'Bia', lastName: 'Souza' });

      const response = await listTrainers(adminToken);

      expect(response.json().items[0]).toMatchObject({
        firstName: 'Bia',
        lastName: 'Souza',
        email,
      });
    });

    it('reports tier, status and cap for a subscribed trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, PRO);

      const response = await listTrainers(adminToken);

      expect(response.json().items[0]).toMatchObject({
        tier: PRO,
        subscriptionStatus: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
        studentCap: PLAN_LIMITS.PRO.studentCap,
      });
    });

    it('returns studentCap null for a DIAMOND trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, DIAMOND);

      const response = await listTrainers(adminToken);

      expect(response.json().items[0].studentCap).toBeNull();
    });

    it('flags hasAsaasSubscription for a trainer billed through Asaas', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await prisma.platformSubscription.create({
        data: {
          trainerId,
          tier: PRO,
          status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
          asaasSubscriptionId: 'sub_asaas_e2e',
        },
      });

      const response = await listTrainers(adminToken);

      expect(response.json().items[0].hasAsaasSubscription).toBe(true);
    });

    it('counts only students active on the plan', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await linkStudents(app, trainerId, { count: 4, blockedCount: 1 });

      const response = await listTrainers(adminToken);

      expect(response.json().items[0].activeStudents).toBe(3);
    });

    it('filters by search on email', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const target = await createTrainerWithToken(app);
      await createTrainerWithToken(app);

      const response = await listTrainers(adminToken, `?search=${encodeURIComponent(target.email.toUpperCase())}`);

      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].trainerId).toBe(target.trainerId);
    });

    it('filters by search on name', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const target = await createTrainerWithToken(app, { firstName: 'Zuleica', lastName: 'Qwerty' });
      await createTrainerWithToken(app, { firstName: 'Outro', lastName: 'Nome' });

      const response = await listTrainers(adminToken, '?search=zuleic');

      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].trainerId).toBe(target.trainerId);
    });

    it('paginates with page and pageSize', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      await createTrainerWithToken(app);
      await createTrainerWithToken(app);
      await createTrainerWithToken(app);

      const response = await listTrainers(adminToken, '?page=2&pageSize=2');

      const body = response.json();
      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(body.items).toHaveLength(1);
    });

    it('returns 400 validation.failed when pageSize exceeds 100', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);

      const response = await listTrainers(adminToken, '?pageSize=101');

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('PATCH /admin/trainers/:trainerId/platform-plan', () => {
    it('creates the subscription row (ACTIVE) for a trainer without one', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        trainerId,
        previousTier: FREE,
        tier: PRO,
        changed: true,
        subscriptionStatus: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
        hasAsaasSubscription: false,
        studentCap: PLAN_LIMITS.PRO.studentCap,
      });
      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row).toMatchObject({ tier: PRO, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE });
    });

    it('does not call Asaas when changing the plan', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      await patchPlan(adminToken, trainerId, { tier: PLATINUM });

      expectNoAsaasCalls();
    });

    it('keeps the Asaas subscription id when overriding a billed trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await prisma.platformSubscription.create({
        data: {
          trainerId,
          tier: PRO,
          status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
          asaasSubscriptionId: 'sub_asaas_e2e',
        },
      });

      const response = await patchPlan(adminToken, trainerId, { tier: DIAMOND });

      expect(response.json()).toMatchObject({ tier: DIAMOND, hasAsaasSubscription: true });
      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row.asaasSubscriptionId).toBe('sub_asaas_e2e');
      expectNoAsaasCalls();
    });

    it('allows setting a paid trainer to FREE', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, PRO);

      const response = await patchPlan(adminToken, trainerId, { tier: FREE });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ previousTier: PRO, tier: FREE, changed: true });
      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row.tier).toBe(FREE);
    });

    it('blocks the oldest students over the new cap on a downgrade', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, PRO);
      const extraStudents = 2;
      const studentIds = await linkStudents(app, trainerId, {
        count: PLAN_LIMITS.FREE.studentCap + extraStudents,
      });

      const response = await patchPlan(adminToken, trainerId, { tier: FREE });

      expect(response.statusCode).toBe(200);
      expect(response.json().activeStudents).toBe(PLAN_LIMITS.FREE.studentCap);
      const blocked = await prisma.trainerStudent.findMany({
        where: { trainerId, activeOnPlan: false },
        select: { studentId: true },
      });
      expect(blocked.map((link) => link.studentId).sort()).toEqual(
        studentIds.slice(0, extraStudents).sort()
      );
    });

    it('reactivates blocked students on an upgrade', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await linkStudents(app, trainerId, { count: 5, blockedCount: 2 });

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(200);
      expect(response.json().activeStudents).toBe(5);
      const stillBlocked = await prisma.trainerStudent.count({
        where: { trainerId, activeOnPlan: false },
      });
      expect(stillBlocked).toBe(0);
    });

    it('reactivates every blocked student on an upgrade to DIAMOND', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, FREE);
      await linkStudents(app, trainerId, { count: 6, blockedCount: 4 });

      const response = await patchPlan(adminToken, trainerId, { tier: DIAMOND });

      expect(response.json()).toMatchObject({ activeStudents: 6, studentCap: null });
    });

    it('returns 200 changed:false and writes nothing when the tier is unchanged', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      const before = await provisionTrainerPlan(trainerId, PRO);

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ previousTier: PRO, tier: PRO, changed: false });
      const after = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it('returns changed:false without creating a row when a no-subscription trainer is set to FREE', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(adminToken, trainerId, { tier: FREE });

      expect(response.json()).toMatchObject({ tier: FREE, changed: false });
      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row).toBeNull();
    });

    it('returns 404 resource.notFound for an unknown trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);

      const response = await patchPlan(adminToken, UNKNOWN_TRAINER_ID, { tier: PRO });

      expect(response.statusCode).toBe(404);
      expectErrorContract(response.json(), { error: 'NOT_FOUND', messageCode: 'resource.notFound' });
    });

    it('returns 400 validation.failed for an unknown tier', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(adminToken, trainerId, { tier: 'GOLD' });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 400 validation.failed when tier is missing', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(adminToken, trainerId, {});

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 400 validation.failed for extra body properties', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);

      const response = await patchPlan(adminToken, trainerId, { tier: PRO, status: 'ACTIVE' });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 validation.failed for a non-uuid trainerId', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);

      const response = await patchPlan(adminToken, 'not-a-uuid', { tier: PRO });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });
});

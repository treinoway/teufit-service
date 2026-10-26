import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  linkStudents,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import {
  PAST_DUE_GRACE_DAYS,
  PLAN_LIMITS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';

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

const { FREE, PRO, PLATINUM } = PLATFORM_PLAN_TIERS;
const { ACTIVE, PAST_DUE } = PLATFORM_SUBSCRIPTION_STATUSES;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

e2eDescribe('e2e: admin trainer plan management — review fixes', () => {
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

  function listTrainers(accessToken, query = '') {
    return app.inject({
      method: 'GET',
      url: `/admin/trainers${query}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function patchPlan(accessToken, trainerId, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/admin/trainers/${trainerId}/platform-plan`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
  }

  describe('soft-deleted trainers', () => {
    it('excludes a soft-deleted trainer from the list items and the total', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const live = await createTrainerWithToken(app);
      const deleted = await createTrainerWithToken(app);
      await prisma.trainer.update({ where: { id: deleted.trainerId }, data: { deletedAt: new Date() } });

      const body = (await listTrainers(adminToken)).json();

      expect(body.total).toBe(1);
      expect(body.items.map((item) => item.trainerId)).toEqual([live.trainerId]);
    });

    it('excludes a trainer whose user is soft-deleted from the list and the total', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const live = await createTrainerWithToken(app);
      const deleted = await createTrainerWithToken(app);
      await prisma.user.update({ where: { id: deleted.userId }, data: { deletedAt: new Date() } });

      const body = (await listTrainers(adminToken)).json();

      expect(body.total).toBe(1);
      expect(body.items[0].trainerId).toBe(live.trainerId);
    });

    it('returns 404 resource.notFound when setting the plan of a soft-deleted trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await prisma.trainer.update({ where: { id: trainerId }, data: { deletedAt: new Date() } });

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'resource.notFound',
        message: expect.any(String),
      });
    });

    it('does not create a subscription row for a soft-deleted trainer', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await prisma.trainer.update({ where: { id: trainerId }, data: { deletedAt: new Date() } });

      await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(await prisma.platformSubscription.findUnique({ where: { trainerId } })).toBeNull();
    });
  });

  describe('past-due subscription overridden by admin', () => {
    it('ends ACTIVE with pastDueSince cleared after the admin raises the tier', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      const withinGrace = new Date(Date.now() - Math.max(PAST_DUE_GRACE_DAYS - 3, 1) * MS_PER_DAY);
      await prisma.platformSubscription.create({
        data: { trainerId, tier: PRO, status: PAST_DUE, pastDueSince: withinGrace },
      });

      const response = await patchPlan(adminToken, trainerId, { tier: PLATINUM });

      expect(response.statusCode).toBe(200);
      const row = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(row).toMatchObject({ tier: PLATINUM, status: ACTIVE, pastDueSince: null });
    });

    it('reports subscriptionStatus ACTIVE in the response', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await prisma.platformSubscription.create({
        data: { trainerId, tier: FREE, status: PAST_DUE, pastDueSince: new Date() },
      });

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.json()).toMatchObject({ tier: PRO, subscriptionStatus: ACTIVE });
    });
  });

  describe('full-name search', () => {
    it('finds a trainer by "firstName lastName"', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const target = await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Souza' });
      await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Lima' });
      await createTrainerWithToken(app, { firstName: 'Bruno', lastName: 'Souza' });

      const body = (await listTrainers(adminToken, `?search=${encodeURIComponent('Ana Souza')}`)).json();

      expect(body.total).toBe(1);
      expect(body.items[0].trainerId).toBe(target.trainerId);
    });

    it('matches tokens case-insensitively with extra whitespace', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const target = await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Souza' });

      const body = (await listTrainers(adminToken, `?search=${encodeURIComponent('  souza   ANA ')}`)).json();

      expect(body.items.map((item) => item.trainerId)).toEqual([target.trainerId]);
    });
  });

  describe('partial reactivation up to the new cap', () => {
    it('reactivates only the oldest blocked students when free slots are fewer than blocked links', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      const blockedCount = 5;
      const freeSlots = 2;
      const activeCount = PLAN_LIMITS.PRO.studentCap - freeSlots;
      const studentIds = await linkStudents(app, trainerId, {
        count: blockedCount + activeCount,
        blockedCount,
      });

      const response = await patchPlan(adminToken, trainerId, { tier: PRO });

      expect(response.statusCode).toBe(200);
      expect(response.json().activeStudents).toBe(PLAN_LIMITS.PRO.studentCap);
      const stillBlocked = await prisma.trainerStudent.findMany({
        where: { trainerId, activeOnPlan: false },
        select: { studentId: true },
      });
      expect(stillBlocked.map((link) => link.studentId).sort()).toEqual(
        studentIds.slice(freeSlots, blockedCount).sort()
      );
    });
  });
});

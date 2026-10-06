import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
} from '../../src/constants/subscription.js';
import { signupVerified } from '../helpers/signup-user.js';
import { SubscriptionStatus } from '../../src/constants/subscription.js';
import {
  createStudent as createBillingStudent,
  createSubscriptionRow,
  linkStudent,
} from '../helpers/billing-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: subscription plans', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `trainer+subplan+${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeRes.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `student+subplan+${Date.now()}@example.com`;
    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();
    return { userId, accessToken };
  }

  async function createPlan(accessToken, overrides = {}) {
    return app.inject({
      method: 'POST',
      url: '/trainer/subscription-plans',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Plano Mensal',
        recurrence: 'monthly',
        price: 150,
        ...overrides,
      },
    });
  }

  // ─── POST /trainer/subscription-plans ─────────────────────────────────────

  describe('POST /trainer/subscription-plans', () => {
    it('creates a plan and returns 201', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createPlan(accessToken);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Plano Mensal');
      expect(body.recurrence).toBe('monthly');
      expect(Number(body.price)).toBe(150);
      expect(body.isArchived).toBe(false);
      expect(body.recurrenceLabel).toBeDefined();
    });

    it('returns 400 when both discounts are provided', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createPlan(accessToken, { discountPercent: 10, discountAmount: 5 });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe(SubscriptionErrorCode.BOTH_DISCOUNTS_SET);
      expect(body.messageCode).toBe(SubscriptionMessageCode.BOTH_DISCOUNTS_SET);
    });

    it('rejects a discountPercent with more than 2 decimals with 400 SUBSCRIPTION_INVALID_AMOUNT', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createPlan(accessToken, { discountPercent: 33.333 });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: SubscriptionErrorCode.INVALID_AMOUNT,
        messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      });
    });

    it('accepts a discountPercent with exactly 2 decimals and does not include activeSubscriptionCount', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createPlan(accessToken, { discountPercent: 33.33 });

      expect(res.statusCode).toBe(201);
      expect(res.json().discountPercent).toBe('33.33');
      expect(res.json()).not.toHaveProperty('activeSubscriptionCount');
    });

    it('returns 400 when discount amount exceeds price', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createPlan(accessToken, { discountAmount: 200 });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(SubscriptionErrorCode.DISCOUNT_EXCEEDS_PRICE);
    });

    it('returns 403 without trainer role', async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await createPlan(accessToken);

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/subscription-plans',
        payload: { name: 'Test', recurrence: 'monthly', price: 100 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── GET /trainer/subscription-plans ──────────────────────────────────────

  describe('GET /trainer/subscription-plans', () => {
    it('returns only active plans by default', async () => {
      const { accessToken } = await createTrainerWithToken();

      await createPlan(accessToken, { name: 'Plano A' });
      const planRes = await createPlan(accessToken, { name: 'Plano B' });
      const planId = planRes.json().id;

      // Archive one plan
      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/subscription-plans',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const plans = res.json();
      expect(plans.every((p) => !p.isArchived)).toBe(true);
      expect(plans).toHaveLength(1);
    });

    it('counts only active subscriptions per plan (2 active + 1 cancelled => 2; no subs => 0)', async () => {
      const trainer = await createTrainerWithToken();
      const busyPlan = (await createPlan(trainer.accessToken, { name: 'Busy' })).json();
      const idlePlan = (await createPlan(trainer.accessToken, { name: 'Idle' })).json();
      const [studentA, studentB, studentC] = [
        await createBillingStudent(app),
        await createBillingStudent(app),
        await createBillingStudent(app),
      ];
      for (const student of [studentA, studentB, studentC]) {
        await linkStudent(trainer.trainerId, student.userId);
      }
      const base = { trainerId: trainer.trainerId, planId: busyPlan.id };
      await createSubscriptionRow({ ...base, studentId: studentA.userId });
      await createSubscriptionRow({ ...base, studentId: studentB.userId });
      await createSubscriptionRow({ ...base, studentId: studentC.userId, status: SubscriptionStatus.CANCELLED });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/subscription-plans',
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const countById = Object.fromEntries(res.json().map((plan) => [plan.id, plan.activeSubscriptionCount]));
      expect(countById).toEqual({ [busyPlan.id]: 2, [idlePlan.id]: 0 });
    });

    it('includes the count for archived plans when includeArchived=true', async () => {
      const trainer = await createTrainerWithToken();
      const plan = (await createPlan(trainer.accessToken, { name: 'To archive' })).json();
      const student = await createBillingStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      await createSubscriptionRow({ trainerId: trainer.trainerId, studentId: student.userId, planId: plan.id });
      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${plan.id}/archive`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/subscription-plans?includeArchived=true',
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      const archived = res.json().find((p) => p.id === plan.id);
      expect(archived).toMatchObject({ isArchived: true, activeSubscriptionCount: 1 });
    });

    it('includes archived plans when includeArchived=true', async () => {
      const { accessToken } = await createTrainerWithToken();

      await createPlan(accessToken, { name: 'Plano A' });
      const planRes = await createPlan(accessToken, { name: 'Plano B' });
      const planId = planRes.json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/subscription-plans?includeArchived=true',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });
  });

  // ─── GET /trainer/subscription-plans/:id ──────────────────────────────────

  describe('GET /trainer/subscription-plans/:id', () => {
    it('returns the plan', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planRes = await createPlan(accessToken);
      const planId = planRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(planId);
    });

    it('returns 404 for a plan from another trainer', async () => {
      const { accessToken: trainer1Token } = await createTrainerWithToken();
      const { accessToken: trainer2Token } = await createTrainerWithToken();

      const planRes = await createPlan(trainer1Token);
      const planId = planRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${trainer2Token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe(SubscriptionErrorCode.PLAN_NOT_FOUND);
    });
  });

  // ─── PATCH /trainer/subscription-plans/:id ────────────────────────────────

  describe('PATCH /trainer/subscription-plans/:id', () => {
    it('updates plan fields', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Plano Atualizado', price: 200 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Plano Atualizado');
      expect(Number(res.json().price)).toBe(200);
    });

    it('rejects a discountPercent with more than 2 decimals with 400 SUBSCRIPTION_INVALID_AMOUNT', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { discountPercent: 33.333 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: SubscriptionErrorCode.INVALID_AMOUNT,
        messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      });
    });

    it('returns 409 when trying to edit an archived plan', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Novo Nome' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(SubscriptionErrorCode.PLAN_ARCHIVED);
    });

    it('returns 404 for a plan from another trainer', async () => {
      const { accessToken: trainer1Token } = await createTrainerWithToken();
      const { accessToken: trainer2Token } = await createTrainerWithToken();

      const planId = (await createPlan(trainer1Token)).json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/subscription-plans/${planId}`,
        headers: { authorization: `Bearer ${trainer2Token}` },
        payload: { name: 'Hack' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── POST /trainer/subscription-plans/:id/archive ─────────────────────────

  describe('POST /trainer/subscription-plans/:id/archive', () => {
    it('archives a plan (isArchived becomes true)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isArchived).toBe(true);
    });

    it('is idempotent — archiving twice returns 200', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isArchived).toBe(true);
    });
  });

  // ─── POST /trainer/subscription-plans/:id/unarchive ───────────────────────

  describe('POST /trainer/subscription-plans/:id/unarchive', () => {
    it('unarchives a plan (isArchived becomes false)', async () => {
      const { accessToken } = await createTrainerWithToken();
      const planId = (await createPlan(accessToken)).json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${planId}/unarchive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isArchived).toBe(false);
    });
  });
});

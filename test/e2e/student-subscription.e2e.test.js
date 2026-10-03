import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  SubscriptionErrorCode,
  SubscriptionStatus,
  PaymentStatus,
} from '../../src/constants/subscription.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: student subscriptions', () => {
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
    const email = `trainer+studsub+${Date.now()}@example.com`;

    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
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
    const email = `student+studsub+${Date.now()}@example.com`;
    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();
    return { userId, accessToken };
  }

  async function linkStudentToTrainer(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
  }

  async function createPlan(accessToken, overrides = {}) {
    const res = await app.inject({
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
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function assignPlan(accessToken, studentId, planId, overrides = {}) {
    return app.inject({
      method: 'POST',
      url: `/trainer/students/${studentId}/subscriptions`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        planId,
        startDate: '2026-05-01',
        ...overrides,
      },
    });
  }

  // ─── POST /trainer/students/:studentId/subscriptions ──────────────────────

  describe('POST /trainer/students/:studentId/subscriptions', () => {
    it('assigns a plan and returns 201 with firstPayment', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken);

      const res = await assignPlan(accessToken, studentId, plan.id);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe(SubscriptionStatus.ACTIVE);
      expect(body.planId).toBe(plan.id);
      expect(body.studentId).toBe(studentId);
      expect(body.firstPayment).toBeDefined();
      expect(body.firstPayment.status).toBe(PaymentStatus.PENDING);
      expect(body.firstPayment.cycleStartDate).toBe('2026-05-01');
      // Monthly: May 1 + 1 month - 1 day = May 31
      expect(body.firstPayment.cycleEndDate).toBe('2026-05-31');
    });

    it('cancels existing active subscription when assigning a new plan', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan1 = await createPlan(accessToken, { name: 'Plano 1' });
      const plan2 = await createPlan(accessToken, { name: 'Plano 2', recurrence: 'quarterly' });

      const firstAssign = await assignPlan(accessToken, studentId, plan1.id);
      expect(firstAssign.statusCode).toBe(201);
      const firstSubId = firstAssign.json().id;

      const secondAssign = await assignPlan(accessToken, studentId, plan2.id, {
        startDate: '2026-06-01',
      });
      expect(secondAssign.statusCode).toBe(201);

      // First subscription should now be cancelled
      const cancelledSub = await prisma.studentSubscription.findFirst({
        where: { id: firstSubId },
      });
      expect(cancelledSub.status).toBe(SubscriptionStatus.CANCELLED);

      // Active subscription should be the new one
      const activeSub = await prisma.studentSubscription.findFirst({
        where: { studentId, status: SubscriptionStatus.ACTIVE },
      });
      expect(activeSub.planId).toBe(plan2.id);
    });

    it('returns 403 when student is not linked to trainer', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(accessToken);

      const res = await assignPlan(accessToken, studentId, plan.id);

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(SubscriptionErrorCode.STUDENT_NOT_LINKED);
    });

    it('returns 409 when plan is archived', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken);

      await app.inject({
        method: 'POST',
        url: `/trainer/subscription-plans/${plan.id}/archive`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await assignPlan(accessToken, studentId, plan.id);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(SubscriptionErrorCode.PLAN_ARCHIVED);
    });

    it('respects discount override at assignment time', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken); // no discount on plan

      const res = await assignPlan(accessToken, studentId, plan.id, {
        discountPercent: 20,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(Number(body.discountPercent)).toBe(20);
      // price 150 - 20% = 120
      expect(Number(body.firstPayment.amount)).toBe(120);
    });
  });

  // ─── GET /trainer/students/:studentId/subscriptions ───────────────────────

  describe('GET /trainer/students/:studentId/subscriptions', () => {
    it('returns all subscriptions for the student (history)', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan1 = await createPlan(accessToken, { name: 'P1' });
      const plan2 = await createPlan(accessToken, { name: 'P2', recurrence: 'quarterly' });

      await assignPlan(accessToken, studentId, plan1.id);
      await assignPlan(accessToken, studentId, plan2.id, { startDate: '2026-06-01' });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/subscriptions`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      // 2 subscriptions (one cancelled, one active)
      expect(res.json()).toHaveLength(2);
    });
  });

  // ─── GET /trainer/students/:studentId/subscriptions/active ────────────────

  describe('GET /trainer/students/:studentId/subscriptions/active', () => {
    it('returns the active subscription', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken);

      await assignPlan(accessToken, studentId, plan.id);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/subscriptions/active`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('returns null when no active subscription', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/subscriptions/active`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });
  });

  // ─── GET /trainer/subscriptions ───────────────────────────────────────────

  describe('GET /trainer/subscriptions', () => {
    it('lists subscriptions across all students', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: student1Id } = await createStudentWithToken();
      const { userId: student2Id } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, student1Id);
      await linkStudentToTrainer(trainerId, student2Id);
      const plan = await createPlan(accessToken);

      await assignPlan(accessToken, student1Id, plan.id);
      await assignPlan(accessToken, student2Id, plan.id, { startDate: '2026-06-01' });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/subscriptions',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });

    it('filters by status', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan1 = await createPlan(accessToken, { name: 'P1' });
      const plan2 = await createPlan(accessToken, { name: 'P2', recurrence: 'quarterly' });

      await assignPlan(accessToken, studentId, plan1.id);
      // assigning plan2 cancels plan1
      await assignPlan(accessToken, studentId, plan2.id, { startDate: '2026-06-01' });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscriptions?status=${SubscriptionStatus.ACTIVE}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const subs = res.json();
      expect(subs.every((s) => s.status === SubscriptionStatus.ACTIVE)).toBe(true);
    });
  });

  // ─── POST /trainer/subscriptions/:id/cancel ───────────────────────────────

  describe('POST /trainer/subscriptions/:id/cancel', () => {
    it('cancels an active subscription', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken);

      const assignRes = await assignPlan(accessToken, studentId, plan.id);
      const subId = assignRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subId}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { reason: 'Cliente solicitou' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe(SubscriptionStatus.CANCELLED);
      expect(body.cancellationReason).toBe('Cliente solicitou');
      expect(body.cancelledAt).not.toBeNull();
    });

    it('returns 409 when subscription is already cancelled', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const plan = await createPlan(accessToken);

      const assignRes = await assignPlan(accessToken, studentId, plan.id);
      const subId = assignRes.json().id;

      await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subId}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const secondCancel = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subId}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(secondCancel.statusCode).toBe(409);
      expect(secondCancel.json().error).toBe(SubscriptionErrorCode.CANNOT_EDIT_CANCELLED);
    });
  });
});

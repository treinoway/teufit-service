import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  SubscriptionErrorCode,
  PaymentStatus,
} from '../../src/constants/subscription.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: subscription payments', () => {
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
    const email = `trainer+subpay+${Date.now()}@example.com`;

    const signupRes = await app.inject({
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
    const email = `student+subpay+${Date.now()}@example.com`;
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();
    return { userId, accessToken };
  }

  async function createPlan(accessToken, overrides = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/subscription-plans',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Plano Mensal',
        recurrence: 'monthly',
        price: 100,
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function setupTrainerStudentAndPlan(recurrence = 'monthly') {
    const { trainerId, accessToken } = await createTrainerWithToken();
    const { userId: studentId } = await createStudentWithToken();
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
    const plan = await createPlan(accessToken, { recurrence });

    const assignRes = await app.inject({
      method: 'POST',
      url: `/trainer/students/${studentId}/subscriptions`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { planId: plan.id, startDate: '2026-05-01' },
    });
    expect(assignRes.statusCode).toBe(201);
    const subscription = assignRes.json();

    return { accessToken, plan, subscription, firstPaymentId: subscription.firstPayment.id };
  }

  // ─── Full payment lifecycle ────────────────────────────────────────────────

  describe('payment lifecycle: assign → mark paid → mark pending', () => {
    it('full lifecycle works correctly', async () => {
      const { accessToken, firstPaymentId } = await setupTrainerStudentAndPlan();

      // 1. Mark payment as paid
      const paidRes = await app.inject({
        method: 'POST',
        url: `/trainer/payments/${firstPaymentId}/mark-paid`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(paidRes.statusCode).toBe(200);
      expect(paidRes.json().status).toBe(PaymentStatus.PAID);
      expect(paidRes.json().paidAt).not.toBeNull();

      // 3. Mark payment back to pending
      const pendingRes = await app.inject({
        method: 'POST',
        url: `/trainer/payments/${firstPaymentId}/mark-pending`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().status).toBe(PaymentStatus.PENDING);
      expect(pendingRes.json().paidAt).toBeNull();
    });
  });

  // ─── POST /trainer/subscriptions/:subscriptionId/payments ─────────────────

  describe('POST /trainer/subscriptions/:subscriptionId/payments', () => {
    it('creates a payment cycle with correct dates (monthly)', async () => {
      const { accessToken, subscription } = await setupTrainerStudentAndPlan('monthly');

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { cycleStartDate: '2026-06-01' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.cycleStartDate).toBe('2026-06-01');
      // June 1 + 1 month - 1 day = June 30
      expect(body.cycleEndDate).toBe('2026-06-30');
      expect(body.dueDate).toBe('2026-06-01');
      expect(body.status).toBe(PaymentStatus.PENDING);
    });

    it('creates a payment cycle with correct dates (quarterly)', async () => {
      const { accessToken, subscription } = await setupTrainerStudentAndPlan('quarterly');

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { cycleStartDate: '2026-01-01' },
      });

      expect(res.statusCode).toBe(201);
      // Jan 1 + 3 months - 1 day = Mar 31
      expect(res.json().cycleEndDate).toBe('2026-03-31');
    });

    it('uses custom dueDate when provided', async () => {
      const { accessToken, subscription } = await setupTrainerStudentAndPlan();

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { cycleStartDate: '2026-06-01', dueDate: '2026-06-10' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().dueDate).toBe('2026-06-10');
    });

    it('returns 404 when subscription not found', async () => {
      const { accessToken } = await setupTrainerStudentAndPlan();
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${fakeId}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { cycleStartDate: '2026-06-01' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe(SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND);
    });
  });

  // ─── GET /trainer/subscriptions/:subscriptionId/payments ──────────────────

  describe('GET /trainer/subscriptions/:subscriptionId/payments', () => {
    it('lists all payments for a subscription', async () => {
      const { accessToken, subscription } = await setupTrainerStudentAndPlan();

      // Create a second payment
      await app.inject({
        method: 'POST',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { cycleStartDate: '2026-06-01' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });

    it('returns 404 for a subscription from another trainer', async () => {
      const { subscription } = await setupTrainerStudentAndPlan();
      const { accessToken: otherToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscriptions/${subscription.id}/payments`,
        headers: { authorization: `Bearer ${otherToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── PATCH /trainer/payments/:id ──────────────────────────────────────────

  describe('PATCH /trainer/payments/:id', () => {
    it('updates notes and dueDate', async () => {
      const { accessToken, firstPaymentId } = await setupTrainerStudentAndPlan();

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/payments/${firstPaymentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { dueDate: '2026-05-15', notes: 'Pagamento via pix' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().dueDate).toBe('2026-05-15');
      expect(res.json().notes).toBe('Pagamento via pix');
    });

    it('returns 404 for a payment from another trainer', async () => {
      const { firstPaymentId } = await setupTrainerStudentAndPlan();
      const { accessToken: otherToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/payments/${firstPaymentId}`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { notes: 'Hack' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── POST /trainer/payments/:id/mark-paid ─────────────────────────────────

  describe('POST /trainer/payments/:id/mark-paid', () => {
    it('marks payment as paid', async () => {
      const { accessToken, firstPaymentId } = await setupTrainerStudentAndPlan();

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/payments/${firstPaymentId}/mark-paid`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(PaymentStatus.PAID);
      expect(res.json().paidAt).not.toBeNull();
      expect(res.json().statusLabel).toBeDefined();
    });

    it('returns 404 when payment not found', async () => {
      const { accessToken } = await setupTrainerStudentAndPlan();
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/payments/${fakeId}/mark-paid`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe(SubscriptionErrorCode.PAYMENT_NOT_FOUND);
    });
  });

  // ─── POST /trainer/payments/:id/mark-pending ──────────────────────────────

  describe('POST /trainer/payments/:id/mark-pending', () => {
    it('marks a paid payment back to pending', async () => {
      const { accessToken, firstPaymentId } = await setupTrainerStudentAndPlan();

      await app.inject({
        method: 'POST',
        url: `/trainer/payments/${firstPaymentId}/mark-paid`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/payments/${firstPaymentId}/mark-pending`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(PaymentStatus.PENDING);
      expect(res.json().paidAt).toBeNull();
    });
  });

  // ─── DELETE /trainer/payments/:id ─────────────────────────────────────────

  describe('DELETE /trainer/payments/:id', () => {
    it('deletes a payment and returns 204', async () => {
      const { accessToken, firstPaymentId } = await setupTrainerStudentAndPlan();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/payments/${firstPaymentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(204);

      // Verify deletion from DB
      const payment = await prisma.subscriptionPayment.findFirst({
        where: { id: firstPaymentId },
      });
      expect(payment).toBeNull();
    });

    it('returns 404 when payment not found', async () => {
      const { accessToken } = await setupTrainerStudentAndPlan();
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/payments/${fakeId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a payment from another trainer', async () => {
      const { firstPaymentId } = await setupTrainerStudentAndPlan();
      const { accessToken: otherToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/payments/${firstPaymentId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

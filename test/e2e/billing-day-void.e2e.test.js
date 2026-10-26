import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { PaymentStatus } from '../../src/constants/subscription.js';
import { addMonthsClamped, formatDateOnly } from '../../src/helpers/date-helpers.js';
import {
  authHeader,
  businessDay,
  businessDayString,
  createPlanViaApi,
  createStudent,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const FUTURE_START_OFFSET = 8;
const CYCLE_START_OFFSET = -5;

// Billing day whose aligned cycle 0 (for a start 8 days ahead) starts 5 days before today.
const billingDayStartingBeforeToday = () => businessDay(CYCLE_START_OFFSET).getUTCDate();

e2eDescribe('e2e: billing day — effective start voiding rules', () => {
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

  async function setup() {
    const trainer = await createTrainer(app);
    const student = await createStudent(app);
    await linkStudent(trainer.trainerId, student.userId);
    const plan = await createPlanViaApi(app, trainer.accessToken);
    return { ...trainer, studentId: student.userId, plan };
  }

  const assign = (ctx, payload, planId = ctx.plan.id) =>
    app.inject({
      method: 'POST',
      url: `/trainer/students/${ctx.studentId}/subscriptions`,
      headers: authHeader(ctx.accessToken),
      payload: { planId, ...payload },
    });

  async function assignOk(ctx, payload, planId) {
    const res = await assign(ctx, payload, planId);
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  const cancelSubscription = (ctx, subscriptionId) =>
    app.inject({
      method: 'POST',
      url: `/trainer/subscriptions/${subscriptionId}/cancel`,
      headers: authHeader(ctx.accessToken),
      payload: { reason: 'teste' },
    });

  const unlinkStudent = (ctx) =>
    app.inject({
      method: 'DELETE',
      url: `/trainer/students/${ctx.studentId}`,
      headers: authHeader(ctx.accessToken),
    });

  const patchPayment = (ctx, paymentId, payload) =>
    app.inject({
      method: 'PATCH',
      url: `/trainer/payments/${paymentId}`,
      headers: authHeader(ctx.accessToken),
      payload,
    });

  const paymentStatus = async (paymentId) =>
    (await prisma.subscriptionPayment.findUnique({ where: { id: paymentId } })).status;

  const futureStartWithCycleBeforeToday = async (ctx, extra = {}) => {
    const subscription = await assignOk(ctx, {
      startDate: businessDayString(FUTURE_START_OFFSET),
      billingDay: billingDayStartingBeforeToday(),
      ...extra,
    });
    expect(subscription.firstPayment.cycleStartDate).toBe(businessDayString(CYCLE_START_OFFSET));
    expect(subscription.firstPayment.dueDate).toBe(businessDayString(FUTURE_START_OFFSET));
    return subscription;
  };

  describe('cancel and unlink of a subscription that has not started yet', () => {
    it('cancel voids the first payment when its cycle started before today but the subscription starts in the future', async () => {
      const ctx = await setup();
      const subscription = await futureStartWithCycleBeforeToday(ctx);

      const res = await cancelSubscription(ctx, subscription.id);

      expect(res.statusCode).toBe(200);
      expect(await paymentStatus(subscription.firstPayment.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('unlink voids the first payment when its cycle started before today but the subscription starts in the future', async () => {
      const ctx = await setup();
      const subscription = await futureStartWithCycleBeforeToday(ctx);

      const res = await unlinkStudent(ctx);

      expect(res.statusCode).toBe(204);
      expect(await paymentStatus(subscription.firstPayment.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('cancel keeps the pending payment of a legacy (billingDay null) subscription that started in the past', async () => {
      const ctx = await setup();
      const subscription = await assignOk(ctx, { startDate: businessDayString(-10) });

      await cancelSubscription(ctx, subscription.id);

      expect(await paymentStatus(subscription.firstPayment.id)).toBe(PaymentStatus.PENDING);
    });

    it('cancel keeps a past cycle whose dueDate was PATCHed into the future (legacy subscription)', async () => {
      const ctx = await setup();
      const subscription = await assignOk(ctx, { startDate: businessDayString(-10) });
      const patchRes = await patchPayment(ctx, subscription.firstPayment.id, {
        dueDate: businessDayString(20),
      });
      expect(patchRes.statusCode).toBe(200);

      await cancelSubscription(ctx, subscription.id);

      expect(await paymentStatus(subscription.firstPayment.id)).toBe(PaymentStatus.PENDING);
    });

    it('cancel keeps a rendered cycle whose dueDate was PATCHed into the future (billingDay set, subscription starting today)', async () => {
      const ctx = await setup();
      const subscription = await assignOk(ctx, {
        startDate: businessDayString(0),
        billingDay: businessDay(CYCLE_START_OFFSET).getUTCDate(),
      });
      const patchRes = await patchPayment(ctx, subscription.firstPayment.id, {
        dueDate: businessDayString(20),
      });
      expect(patchRes.statusCode).toBe(200);

      await cancelSubscription(ctx, subscription.id);

      expect(await paymentStatus(subscription.firstPayment.id)).toBe(PaymentStatus.PENDING);
    });
  });

  describe('re-assigning a plan with the same future start date', () => {
    const pendingPaymentIds = async (ctx) =>
      (
        await prisma.subscriptionPayment.findMany({
          where: { subscription: { studentId: ctx.studentId }, status: PaymentStatus.PENDING },
          select: { id: true },
        })
      ).map((payment) => payment.id);

    it('voids the replaced first payments and leaves only the latest first payment pending (different billing day, then no override)', async () => {
      const ctx = await setup();
      const planC = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano C' });
      const planD = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano D' });
      const startDate = businessDayString(FUTURE_START_OFFSET);
      const first = await futureStartWithCycleBeforeToday(ctx);

      const second = await assignOk(ctx, { startDate, billingDay: businessDay(-3).getUTCDate() }, planC.id);
      const third = await assignOk(ctx, { startDate }, planD.id);

      expect(await paymentStatus(first.firstPayment.id)).toBe(PaymentStatus.CANCELLED);
      expect(await paymentStatus(second.firstPayment.id)).toBe(PaymentStatus.CANCELLED);
      expect(await pendingPaymentIds(ctx)).toEqual([third.firstPayment.id]);
    });

    it('voids the replaced first payment when the re-assign sends an explicit billingDay null', async () => {
      const ctx = await setup();
      const planC = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano C' });
      const startDate = businessDayString(FUTURE_START_OFFSET);
      const first = await futureStartWithCycleBeforeToday(ctx);

      const second = await assignOk(ctx, { startDate, billingDay: null }, planC.id);

      expect(await paymentStatus(first.firstPayment.id)).toBe(PaymentStatus.CANCELLED);
      expect(await pendingPaymentIds(ctx)).toEqual([second.firstPayment.id]);
    });
  });

  describe('future-dated replace of an existing subscription', () => {
    it('keeps the old plan pending charge that is already due', async () => {
      const ctx = await setup();
      const planB = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano B' });
      const old = await assignOk(ctx, { startDate: businessDayString(-3) });

      await futureStartWithCycleBeforeToday({ ...ctx, plan: planB });

      expect(await paymentStatus(old.firstPayment.id)).toBe(PaymentStatus.PENDING);
    });

    it('materializes old plan cycles starting in [today+1, S-1] as pending and keeps none starting on/after S', async () => {
      const ctx = await setup();
      const planB = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano B' });
      const futureStartOffset = 14;
      const oldStart = businessDay(-20);
      const old = await assignOk(ctx, { startDate: formatDateOnly(oldStart) });
      const oldNextCycleStart = addMonthsClamped(oldStart, 1);
      const newStart = businessDay(futureStartOffset);
      expect(oldNextCycleStart > businessDay(0) && oldNextCycleStart < newStart).toBe(true);

      await assignOk(
        ctx,
        { startDate: formatDateOnly(newStart), billingDay: billingDayStartingBeforeToday() },
        planB.id,
      );

      const oldPayments = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: old.id },
        orderBy: { cycleIndex: 'asc' },
      });
      const pendingStarts = oldPayments
        .filter((payment) => payment.status === PaymentStatus.PENDING)
        .map((payment) => formatDateOnly(payment.cycleStartDate));
      expect(pendingStarts).toEqual([formatDateOnly(oldStart), formatDateOnly(oldNextCycleStart)]);
      const startingOnOrAfterNewStart = oldPayments.filter(
        (payment) => payment.status === PaymentStatus.PENDING && payment.cycleStartDate >= newStart,
      );
      expect(startingOnOrAfterNewStart).toEqual([]);
    });
  });

  describe('billingDay input handling', () => {
    it('assign with billingDay null falls back to the plan billingDay (stored = plan)', async () => {
      const ctx = await setup();
      const planWithDay = await createPlanViaApi(app, ctx.accessToken, { name: 'Dia 5', billingDay: 5 });

      const res = await assign(ctx, { startDate: businessDayString(0), billingDay: null }, planWithDay.id);

      expect(res.statusCode).toBe(201);
      expect(res.json().billingDay).toBe(5);
      const stored = await prisma.studentSubscription.findUnique({ where: { id: res.json().id } });
      expect(stored.billingDay).toBe(5);
    });

    it('rejects a non-numeric billingDay on plan create with 400 VALIDATION_ERROR', async () => {
      const trainer = await createTrainer(app);

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/subscription-plans',
        headers: authHeader(trainer.accessToken),
        payload: { name: 'Plano', recurrence: 'monthly', price: 100, billingDay: 'abc' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('rejects a non-numeric billingDay on assign with 400 VALIDATION_ERROR', async () => {
      const ctx = await setup();

      const res = await assign(ctx, { startDate: businessDayString(0), billingDay: 'abc' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });
});

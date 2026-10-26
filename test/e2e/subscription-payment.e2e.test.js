import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionRecurrence,
  SubscriptionStatus,
  PaymentStatus,
  EffectivePaymentStatus,
  CANCELLATION_REASON_UNLINKED,
  PAID_AT_MAX_ADVANCE_MONTHS,
} from '../../src/constants/subscription.js';
import { computeCycleBounds } from '../../src/helpers/subscription-helpers.js';
import {
  addMonthsClamped,
  formatDateOnly,
  todayInBusinessTz,
} from '../../src/helpers/date-helpers.js';
import {
  ensureUpcomingCycles,
  insertCyclesForActiveSubscriptions,
} from '../../src/services/subscription-cycle-service.js';
import {
  authHeader,
  assignPlanViaApi,
  businessDay,
  businessDayString,
  createPaymentRow,
  createPlanViaApi,
  createStudent,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

function expectUnifiedError(body, { error, messageCode }) {
  expect(body).toMatchObject({ error, messageCode });
  expect(typeof body.message).toBe('string');
  // `details` is only present when the error carries some (validation errors).
}

e2eDescribe('e2e: subscription payments (financeiro cycle model)', () => {
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

  /** Trainer + linked student + plan + active subscription starting `startOffsetDays` from today. */
  async function setup({ startOffsetDays = -25, recurrence = SubscriptionRecurrence.MONTHLY } = {}) {
    const trainer = await createTrainer(app);
    const student = await createStudent(app);
    await linkStudent(trainer.trainerId, student.userId);
    const plan = await createPlanViaApi(app, trainer.accessToken, { recurrence });
    const assignRes = await assignPlanViaApi(
      app,
      trainer.accessToken,
      student.userId,
      plan.id,
      businessDayString(startOffsetDays),
    );
    expect(assignRes.statusCode).toBe(201);
    const subscription = assignRes.json();

    return {
      ...trainer,
      studentId: student.userId,
      plan,
      subscription,
      firstPaymentId: subscription.firstPayment.id,
    };
  }

  const post = (url, token, payload) =>
    app.inject({ method: 'POST', url, headers: authHeader(token), payload });

  const paymentStatusInDb = async (paymentId) =>
    (await prisma.subscriptionPayment.findUnique({ where: { id: paymentId } })).status;

  // ─── Assign ─────────────────────────────────────────────────────────────────

  describe('POST /trainer/students/:studentId/subscriptions', () => {
    it('creates cycle 0 anchored on startDate, with effectiveStatus/daysOverdue on the first payment', async () => {
      const { subscription } = await setup({ startOffsetDays: -25 });

      const expectedBounds = computeCycleBounds(
        businessDay(-25),
        SubscriptionRecurrence.MONTHLY,
        0,
      );
      expect(subscription.firstPayment).toMatchObject({
        cycleIndex: 0,
        cycleStartDate: businessDayString(-25),
        cycleEndDate: formatDateOnly(expectedBounds.cycleEndDate),
        dueDate: businessDayString(-25),
        status: PaymentStatus.PENDING,
        effectiveStatus: EffectivePaymentStatus.OVERDUE,
        daysOverdue: 25,
        voidedAt: null,
      });
    });

    it('rejects a discountAmount with more than 2 decimals with 400 SUBSCRIPTION_INVALID_AMOUNT', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/students/${student.userId}/subscriptions`,
        headers: authHeader(trainer.accessToken),
        payload: { planId: plan.id, startDate: businessDayString(0), discountAmount: 1.005 },
      });

      expect(res.statusCode).toBe(400);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.INVALID_AMOUNT,
        messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      });
    });

    it('applies half-up rounding to the first payment amount (99.90 with 33.33% => 66.60)', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken, {
        price: 99.9,
        discountPercent: 33.33,
      });

      const res = await assignPlanViaApi(
        app,
        trainer.accessToken,
        student.userId,
        plan.id,
        businessDayString(0),
      );

      expect(res.statusCode).toBe(201);
      expect(Number(res.json().firstPayment.amount)).toBe(66.6);
    });

    it('sequential re-assign replaces the active subscription: voids upcoming and same-day pending (voidedAt set), keeps the already-due debt', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const upcoming = await createPaymentRow(ctx.subscription.id, {
        dueDate: businessDay(10),
      });
      const startsToday = await createPaymentRow(ctx.subscription.id, {
        dueDate: businessDay(0),
      });
      const dueOverdue = ctx.firstPaymentId;

      const secondPlan = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano 2', price: 150 });
      const res = await assignPlanViaApi(
        app,
        ctx.accessToken,
        ctx.studentId,
        secondPlan.id,
        businessDayString(0),
      );

      expect(res.statusCode).toBe(201);
      expect(res.json().firstPayment.cycleIndex).toBe(0);
      expect(await paymentStatusInDb(upcoming.id)).toBe(PaymentStatus.CANCELLED);
      // The new plan bills today's period, so the old same-day charge is voided (no double charge).
      expect(await paymentStatusInDb(startsToday.id)).toBe(PaymentStatus.CANCELLED);
      expect(await paymentStatusInDb(dueOverdue)).toBe(PaymentStatus.PENDING);
      const voidedRows = await prisma.subscriptionPayment.findMany({
        where: { id: { in: [upcoming.id, startsToday.id] } },
      });
      voidedRows.forEach((row) => expect(row.voidedAt).not.toBeNull());
      const historyRes = await app.inject({
        method: 'GET',
        url: `/trainer/students/${ctx.studentId}/payments`,
        headers: authHeader(ctx.accessToken),
      });
      const historyById = new Map(historyRes.json().payments.map((row) => [row.id, row]));
      expect(historyById.get(upcoming.id).voidedAt).toEqual(expect.any(String));
      expect(historyById.get(startsToday.id).voidedAt).toEqual(expect.any(String));
      expect(historyById.get(dueOverdue).voidedAt).toBeNull();
      const old = await prisma.studentSubscription.findUnique({ where: { id: ctx.subscription.id } });
      expect(old.status).toBe(SubscriptionStatus.CANCELLED);
    });

    it('assigning A then B sequentially, both starting today, leaves exactly ONE pending cycle 0 (B\'s) and A\'s is cancelled', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const planA = await createPlanViaApi(app, trainer.accessToken, { name: 'A', price: 100 });
      const planB = await createPlanViaApi(app, trainer.accessToken, { name: 'B', price: 150 });

      const resA = await assignPlanViaApi(app, trainer.accessToken, student.userId, planA.id, businessDayString(0));
      const resB = await assignPlanViaApi(app, trainer.accessToken, student.userId, planB.id, businessDayString(0));

      expect(resA.statusCode).toBe(201);
      expect(resB.statusCode).toBe(201);
      const pending = await prisma.subscriptionPayment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          subscription: { trainerId: trainer.trainerId, studentId: student.userId },
        },
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: resB.json().firstPayment.id, cycleIndex: 0 });
      expect(await paymentStatusInDb(resA.json().firstPayment.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('future-dated replace: old cycles starting before the new start stay pending at full price; those on/after it are voided', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const beforeNewStart = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(3) });
      const onNewStart = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(10) });
      const afterNewStart = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(40) });
      const secondPlan = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano 2' });

      const res = await assignPlanViaApi(
        app, ctx.accessToken, ctx.studentId, secondPlan.id, businessDayString(10),
      );

      expect(res.statusCode).toBe(201);
      expect(res.json().firstPayment).toMatchObject({ cycleIndex: 0, cycleStartDate: businessDayString(10) });
      // No proration: the old plan keeps billing until the new one starts.
      expect(await paymentStatusInDb(beforeNewStart.id)).toBe(PaymentStatus.PENDING);
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.PENDING);
      // The new plan bills from its first cycle on, so old charges starting then would be duplicates.
      expect(await paymentStatusInDb(onNewStart.id)).toBe(PaymentStatus.CANCELLED);
      expect(await paymentStatusInDb(afterNewStart.id)).toBe(PaymentStatus.CANCELLED);
      const voidedRow = await prisma.subscriptionPayment.findUnique({ where: { id: onNewStart.id } });
      expect(voidedRow.voidedAt).not.toBeNull();
    });

    it('future-dated replace on a monthly plan (new start today+20): old cycles before it exist and stay pending, none of the old plan starts on/after it pending, new cycle 0 starts today+20', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const newStart = businessDay(20);
      const secondPlan = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano 2', price: 150 });

      const res = await assignPlanViaApi(
        app, ctx.accessToken, ctx.studentId, secondPlan.id, formatDateOnly(newStart),
      );

      expect(res.statusCode).toBe(201);
      expect(res.json().firstPayment).toMatchObject({
        cycleIndex: 0,
        cycleStartDate: formatDateOnly(newStart),
        status: PaymentStatus.PENDING,
      });
      const oldPayments = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: ctx.subscription.id },
        orderBy: { cycleIndex: 'asc' },
      });
      const pendingOld = oldPayments.filter((payment) => payment.status === PaymentStatus.PENDING);
      // Cycle 0 (today-25) plus the cycle starting in (today, today+20) materialized at replacement time.
      expect(pendingOld.length).toBeGreaterThanOrEqual(2);
      expect(pendingOld.some((payment) => payment.cycleStartDate > businessDay(0))).toBe(true);
      pendingOld.forEach((payment) => expect(payment.cycleStartDate < newStart).toBe(true));
      oldPayments
        .filter((payment) => payment.cycleStartDate >= newStart)
        .forEach((payment) => expect(payment.status).toBe(PaymentStatus.CANCELLED));
      const old = await prisma.studentSubscription.findUnique({ where: { id: ctx.subscription.id } });
      expect(old.status).toBe(SubscriptionStatus.CANCELLED);
    });

    it('backdated replace: old already-due cycles starting before the new first cycle stay pending (debt); those on/after it are voided', async () => {
      const ctx = await setup({ startOffsetDays: -60 });
      const beforeNewFirstCycle = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-20), cycleIndex: 1000 });
      const afterNewFirstCycle = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-5), cycleIndex: 1001 });
      const secondPlan = await createPlanViaApi(app, ctx.accessToken, { name: 'Plano 2' });

      // Backdated 10 days: the new plan's first billed cycle is the grid cycle containing today.
      const res = await assignPlanViaApi(
        app, ctx.accessToken, ctx.studentId, secondPlan.id, businessDayString(-10),
      );

      expect(res.statusCode).toBe(201);
      expect(res.json().firstPayment.cycleStartDate).toBe(businessDayString(-10));
      expect(await paymentStatusInDb(beforeNewFirstCycle.id)).toBe(PaymentStatus.PENDING);
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.PENDING);
      expect(await paymentStatusInDb(afterNewFirstCycle.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('answers 403 SUBSCRIPTION_STUDENT_NOT_LINKED when the student was unlinked before the assignment', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const unlink = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${ctx.studentId}`,
        headers: authHeader(ctx.accessToken),
      });
      expect(unlink.statusCode).toBe(204);

      const res = await assignPlanViaApi(
        app, ctx.accessToken, ctx.studentId, ctx.plan.id, businessDayString(0),
      );

      expect(res.statusCode).toBe(403);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
    });

    it('concurrent unlink and assign never leave an active subscription for an unlinked student', async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const trainer = await createTrainer(app);
        const student = await createStudent(app);
        await linkStudent(trainer.trainerId, student.userId);
        const plan = await createPlanViaApi(app, trainer.accessToken);

        const [assign, unlink] = await Promise.all([
          assignPlanViaApi(app, trainer.accessToken, student.userId, plan.id, businessDayString(0)),
          app.inject({
            method: 'DELETE',
            url: `/trainer/students/${student.userId}`,
            headers: authHeader(trainer.accessToken),
          }),
        ]);

        expect(assign.statusCode).toBeLessThan(500);
        expect(unlink.statusCode).toBe(204);
        expect([201, 403, 409]).toContain(assign.statusCode);
        expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
        expect(
          await prisma.studentSubscription.count({
            where: { studentId: student.userId, status: SubscriptionStatus.ACTIVE },
          }),
        ).toBe(0);
      }
    });

    it('a start backdated 40 days bills the grid cycle containing today (cycleIndex 1), never a stale cycle 0', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);

      const res = await assignPlanViaApi(app, trainer.accessToken, student.userId, plan.id, businessDayString(-40));

      expect(res.statusCode).toBe(201);
      const expected = computeCycleBounds(businessDay(-40), SubscriptionRecurrence.MONTHLY, 1);
      expect(res.json().startDate).toBe(businessDayString(-40));
      expect(res.json().firstPayment).toMatchObject({
        cycleIndex: 1,
        cycleStartDate: formatDateOnly(expected.cycleStartDate),
        cycleEndDate: formatDateOnly(expected.cycleEndDate),
        dueDate: formatDateOnly(expected.cycleStartDate),
        status: PaymentStatus.PENDING,
      });
      expect(
        await prisma.subscriptionPayment.count({
          where: { subscriptionId: res.json().id, cycleIndex: 0 },
        }),
      ).toBe(0);
    });

    it('concurrent assigns for the same pair leave exactly ONE active subscription and never answer 5xx', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const planA = await createPlanViaApi(app, trainer.accessToken, { name: 'A' });
      const planB = await createPlanViaApi(app, trainer.accessToken, { name: 'B' });
      const pairWhere = { trainerId: trainer.trainerId, studentId: student.userId };
      let createdSoFar = 0;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const responses = await Promise.all([
          assignPlanViaApi(app, trainer.accessToken, student.userId, planA.id, businessDayString(0)),
          assignPlanViaApi(app, trainer.accessToken, student.userId, planB.id, businessDayString(0)),
        ]);

        const statuses = responses.map((res) => res.statusCode).sort();
        // Truly concurrent: 201 + 409. Serialized by timing: 201 + 201 where the first was replaced.
        expect([[201, 201], [201, 409]]).toContainEqual(statuses);
        responses
          .filter((res) => res.statusCode === 409)
          .forEach((res) => {
            expect(res.json()).toMatchObject({
              error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
              messageCode: SubscriptionMessageCode.SUBSCRIPTION_ALREADY_ACTIVE,
            });
            expect(res.json().message).not.toMatch(/try again/i);
          });

        createdSoFar += responses.filter((res) => res.statusCode === 201).length;
        const activeCount = await prisma.studentSubscription.count({
          where: { ...pairWhere, status: SubscriptionStatus.ACTIVE },
        });
        const totalCount = await prisma.studentSubscription.count({ where: pairWhere });
        expect(activeCount).toBe(1);
        // Every 201 produced a row; all but the active one were replaced (cancelled).
        expect(totalCount).toBe(createdSoFar);
      }
    });

    it('a student linked to TWO trainers can have one active subscription from each (per-trainer uniqueness)', async () => {
      const trainerA = await createTrainer(app);
      const trainerB = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainerA.trainerId, student.userId);
      await linkStudent(trainerB.trainerId, student.userId);
      const planA = await createPlanViaApi(app, trainerA.accessToken, { name: 'A' });
      const planB = await createPlanViaApi(app, trainerB.accessToken, { name: 'B', price: 250 });

      const resA = await assignPlanViaApi(app, trainerA.accessToken, student.userId, planA.id, businessDayString(0));
      const resB = await assignPlanViaApi(app, trainerB.accessToken, student.userId, planB.id, businessDayString(0));

      expect(resA.statusCode).toBe(201);
      expect(resB.statusCode).toBe(201);
      expect(
        await prisma.studentSubscription.count({
          where: { studentId: student.userId, status: SubscriptionStatus.ACTIVE },
        }),
      ).toBe(2);

      for (const [trainer, created] of [[trainerA, resA.json()], [trainerB, resB.json()]]) {
        const active = await app.inject({
          method: 'GET',
          url: `/trainer/students/${student.userId}/subscriptions/active`,
          headers: authHeader(trainer.accessToken),
        });
        const list = await app.inject({
          method: 'GET',
          url: '/trainer/subscriptions',
          headers: authHeader(trainer.accessToken),
        });
        expect(active.json()).toMatchObject({ id: created.id, trainerId: trainer.trainerId, status: SubscriptionStatus.ACTIVE });
        expect(list.json().map((subscription) => subscription.id)).toEqual([created.id]);
      }
    });

    it('re-assigning by the same trainer replaces only that trainer\'s subscription, leaving the other trainer\'s active', async () => {
      const trainerA = await createTrainer(app);
      const trainerB = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainerA.trainerId, student.userId);
      await linkStudent(trainerB.trainerId, student.userId);
      const planA = await createPlanViaApi(app, trainerA.accessToken, { name: 'A' });
      const planB = await createPlanViaApi(app, trainerB.accessToken, { name: 'B' });
      const firstA = await assignPlanViaApi(app, trainerA.accessToken, student.userId, planA.id, businessDayString(0));
      const onlyB = await assignPlanViaApi(app, trainerB.accessToken, student.userId, planB.id, businessDayString(0));

      const secondA = await assignPlanViaApi(app, trainerA.accessToken, student.userId, planA.id, businessDayString(0));

      expect(secondA.statusCode).toBe(201);
      const statusOf = async (id) =>
        (await prisma.studentSubscription.findUnique({ where: { id } })).status;
      expect(await statusOf(firstA.json().id)).toBe(SubscriptionStatus.CANCELLED);
      expect(await statusOf(secondA.json().id)).toBe(SubscriptionStatus.ACTIVE);
      expect(await statusOf(onlyB.json().id)).toBe(SubscriptionStatus.ACTIVE);
    });

    it('a subscription backdated one year starts at the current grid cycle, with no burst of past cycles', async () => {
      const ctx = await setup({ startOffsetDays: -365 });
      const first = ctx.subscription.firstPayment;
      expect(first.cycleIndex).toBeGreaterThanOrEqual(11);
      expect(first.cycleEndDate >= businessDayString(0)).toBe(true);

      const overviewRes = await app.inject({
        method: 'GET',
        url: '/trainer/finance/overview',
        headers: authHeader(ctx.accessToken),
      });
      expect(overviewRes.statusCode).toBe(200);

      const cycles = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: ctx.subscription.id },
        orderBy: { cycleIndex: 'asc' },
      });
      expect(cycles.length).toBeLessThanOrEqual(2);
      expect(cycles[0].cycleIndex).toBe(first.cycleIndex);
      cycles.forEach((cycle) => {
        expect(cycle.cycleEndDate.getTime()).toBeGreaterThanOrEqual(businessDay(0).getTime());
      });
    });
  });

  // ─── Cancel / unlink ───────────────────────────────────────────────────────

  describe('ending a subscription voids future pending payments but keeps due ones', () => {
    async function seedMixedPayments(ctx) {
      return {
        overdue: ctx.firstPaymentId, // cycle 0, due 25 days ago
        startsToday: (await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(0) })).id,
        upcoming: (await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(1) })).id,
        farFuture: (await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(40) })).id,
        paidFuture: (
          await createPaymentRow(ctx.subscription.id, {
            dueDate: businessDay(70),
            status: PaymentStatus.PAID,
            paidAt: new Date(),
          })
        ).id,
      };
    }

    async function expectVoidedOnlyFuturePending(ids) {
      expect(await paymentStatusInDb(ids.overdue)).toBe(PaymentStatus.PENDING);
      expect(await paymentStatusInDb(ids.startsToday)).toBe(PaymentStatus.PENDING);
      expect(await paymentStatusInDb(ids.upcoming)).toBe(PaymentStatus.CANCELLED);
      expect(await paymentStatusInDb(ids.farFuture)).toBe(PaymentStatus.CANCELLED);
      expect(await paymentStatusInDb(ids.paidFuture)).toBe(PaymentStatus.PAID);
    }

    it('POST /trainer/subscriptions/:id/cancel', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const ids = await seedMixedPayments(ctx);

      const res = await post(
        `/trainer/subscriptions/${ctx.subscription.id}/cancel`,
        ctx.accessToken,
        { reason: 'Student left' },
      );

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(SubscriptionStatus.CANCELLED);
      await expectVoidedOnlyFuturePending(ids);
    });

    it('double cancel fired concurrently: one 200 and one 409 SUBSCRIPTION_CANNOT_EDIT_CANCELLED', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const url = `/trainer/subscriptions/${ctx.subscription.id}/cancel`;

      const results = await Promise.all([
        post(url, ctx.accessToken, { reason: 'a' }),
        post(url, ctx.accessToken, { reason: 'b' }),
      ]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const loser = results.find((res) => res.statusCode === 409);
      expectUnifiedError(loser.json(), {
        error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
        messageCode: SubscriptionMessageCode.CANNOT_EDIT_CANCELLED,
      });
    });

    it('DELETE /trainer/students/:studentId (unlink) cancels the subscription and voids future pending in one go', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const ids = await seedMixedPayments(ctx);

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${ctx.studentId}`,
        headers: authHeader(ctx.accessToken),
      });

      expect(res.statusCode).toBe(204);
      await expectVoidedOnlyFuturePending(ids);
      const subscription = await prisma.studentSubscription.findUnique({
        where: { id: ctx.subscription.id },
      });
      expect(subscription).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_UNLINKED,
      });
      expect(await prisma.trainerStudent.count({ where: { studentId: ctx.studentId } })).toBe(0);
    });

    it('does not touch the upcoming payments of the trainer\'s other students', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const otherStudent = await createStudent(app);
      await linkStudent(ctx.trainerId, otherStudent.userId);
      const otherSub = await assignPlanViaApi(
        app,
        ctx.accessToken,
        otherStudent.userId,
        ctx.plan.id,
        businessDayString(0),
      );
      expect(otherSub.statusCode).toBe(201);
      const otherUpcoming = await createPaymentRow(otherSub.json().id, { dueDate: businessDay(20) });

      await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${ctx.studentId}`,
        headers: authHeader(ctx.accessToken),
      });

      expect(await paymentStatusInDb(otherUpcoming.id)).toBe(PaymentStatus.PENDING);
    });
  });

  // ─── Generate next cycle ───────────────────────────────────────────────────

  describe('POST /trainer/subscriptions/:subscriptionId/payments', () => {
    it('generates the next cycle from the anchor (cycleIndex 1) and rejects the immediate second call with 409', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const url = `/trainer/subscriptions/${ctx.subscription.id}/payments`;
      const expected = computeCycleBounds(businessDay(-25), SubscriptionRecurrence.MONTHLY, 1);

      const first = await post(url, ctx.accessToken, {});
      const second = await post(url, ctx.accessToken, {});

      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        cycleIndex: 1,
        cycleStartDate: formatDateOnly(expected.cycleStartDate),
        cycleEndDate: formatDateOnly(expected.cycleEndDate),
        dueDate: formatDateOnly(expected.cycleStartDate),
        status: PaymentStatus.PENDING,
      });
      expect(second.statusCode).toBe(409);
      expectUnifiedError(second.json(), {
        error: SubscriptionErrorCode.CYCLE_NOT_DUE,
        messageCode: SubscriptionMessageCode.CYCLE_NOT_DUE,
      });
      expect(
        await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } }),
      ).toBe(2);
    });

    it('two simultaneous requests create exactly one new cycle (the other answers 409)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const url = `/trainer/subscriptions/${ctx.subscription.id}/payments`;

      const results = await Promise.all([
        post(url, ctx.accessToken, {}),
        post(url, ctx.accessToken, {}),
      ]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      const loser = results.find((res) => res.statusCode === 409).json();
      expect([
        SubscriptionErrorCode.CYCLE_ALREADY_EXISTS,
        SubscriptionErrorCode.CYCLE_NOT_DUE,
      ]).toContain(loser.error);
      expect(loser.messageCode).toMatch(/^subscription\.cycle(AlreadyExists|NotDue)$/);
      expect(
        await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } }),
      ).toBe(2);
    });

    it('answers 409 SUBSCRIPTION_CYCLE_NOT_DUE when the next cycle starts beyond today + 7 days', async () => {
      const ctx = await setup({ startOffsetDays: 0 });

      const res = await post(
        `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        ctx.accessToken,
        {},
      );

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(SubscriptionErrorCode.CYCLE_NOT_DUE);
    });

    it('honours an explicit dueDate and notes', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const dueDate = businessDayString(2);

      const res = await post(
        `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        ctx.accessToken,
        { dueDate, notes: 'combinado' },
      );

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ dueDate, notes: 'combinado' });
    });

    it('rejects the legacy body { cycleStartDate } with 400 VALIDATION_ERROR (cycle dates come from the anchor)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });

      const res = await post(
        `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        ctx.accessToken,
        { cycleStartDate: businessDayString(-5) },
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(Array.isArray(res.json().details)).toBe(true);
      expect(
        await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } }),
      ).toBe(1);
    });

    it('answers 409 SUBSCRIPTION_CANCELLED for a cancelled subscription', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/subscriptions/${ctx.subscription.id}/cancel`, ctx.accessToken, {});

      const res = await post(
        `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        ctx.accessToken,
        {},
      );

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.SUBSCRIPTION_CANCELLED,
        messageCode: SubscriptionMessageCode.SUBSCRIPTION_CANCELLED,
      });
    });

    it('returns 404 when the subscription is unknown', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/subscriptions/${MISSING_ID}/payments`, ctx.accessToken, {});

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe(SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND);
    });

    it('returns 401 without a token and 403 for a student', async () => {
      const ctx = await setup();
      const student = await createStudent(app);
      const url = `/trainer/subscriptions/${ctx.subscription.id}/payments`;

      const unauthenticated = await app.inject({ method: 'POST', url, payload: {} });
      const forbidden = await post(url, student.accessToken, {});

      expect(unauthenticated.statusCode).toBe(401);
      expect(forbidden.statusCode).toBe(403);
    });
  });

  // ─── List by subscription ──────────────────────────────────────────────────

  describe('GET /trainer/subscriptions/:subscriptionId/payments', () => {
    it('lists payments with cycleIndex, effectiveStatus and daysOverdue', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/subscriptions/${ctx.subscription.id}/payments`, ctx.accessToken, {});

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        headers: authHeader(ctx.accessToken),
      });

      expect(res.statusCode).toBe(200);
      const payments = res.json();
      expect(payments).toHaveLength(2);
      const cycleZero = payments.find((payment) => payment.cycleIndex === 0);
      expect(cycleZero).toMatchObject({
        effectiveStatus: EffectivePaymentStatus.OVERDUE,
        daysOverdue: 25,
      });
    });

    it('returns 404 for a subscription of another trainer', async () => {
      const ctx = await setup();
      const other = await createTrainer(app);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/subscriptions/${ctx.subscription.id}/payments`,
        headers: authHeader(other.accessToken),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── PATCH ─────────────────────────────────────────────────────────────────

  describe('PATCH /trainer/payments/:id', () => {
    const patch = (ctx, id, payload) =>
      app.inject({
        method: 'PATCH',
        url: `/trainer/payments/${id}`,
        headers: authHeader(ctx.accessToken),
        payload,
      });

    it('updates amount, dueDate and notes of a pending payment', async () => {
      const ctx = await setup();
      const dueDate = businessDayString(-10);

      const res = await patch(ctx, ctx.firstPaymentId, { amount: 80.5, dueDate, notes: 'pix' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ dueDate, notes: 'pix' });
      expect(Number(res.json().amount)).toBe(80.5);
    });

    it('rejects an amount change on a paid payment with 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {});

      const res = await patch(ctx, ctx.firstPaymentId, { amount: 1 });

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
        messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
      });
    });

    it('still allows editing notes of a paid payment', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {});

      const res = await patch(ctx, ctx.firstPaymentId, { notes: 'recibo 42' });

      expect(res.statusCode).toBe(200);
      expect(res.json().notes).toBe('recibo 42');
    });

    it('rejects any edit of a voided payment with 409 SUBSCRIPTION_PAYMENT_CANCELLED', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      const res = await patch(ctx, ctx.firstPaymentId, { notes: 'x' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(SubscriptionErrorCode.PAYMENT_CANCELLED);
    });

    it('rejects an amount with more than 2 decimals as 400 SUBSCRIPTION_INVALID_AMOUNT', async () => {
      const ctx = await setup();

      const res = await patch(ctx, ctx.firstPaymentId, { amount: 10.005 });

      expect(res.statusCode).toBe(400);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.INVALID_AMOUNT,
        messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      });
    });

    it('rejects an amount above 99999999.99 as 400 (schema maximum)', async () => {
      const ctx = await setup();

      const res = await patch(ctx, ctx.firstPaymentId, { amount: 100000000 });

      expect(res.statusCode).toBe(400);
      expectUnifiedError(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('returns 404 for a payment of another trainer', async () => {
      const ctx = await setup();
      const other = await createTrainer(app);

      const res = await patch(other, ctx.firstPaymentId, { notes: 'hack' });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── mark-paid / mark-pending ──────────────────────────────────────────────

  describe('POST /trainer/payments/:id/mark-paid', () => {
    it('marks as paid with paidAt = now when no body is sent (lifecycle with mark-pending)', async () => {
      const ctx = await setup();

      const paid = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);
      const pending = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-pending`, ctx.accessToken);

      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toMatchObject({ status: PaymentStatus.PAID, effectiveStatus: EffectivePaymentStatus.PAID, daysOverdue: 0 });
      expect(paid.json().paidAt).not.toBeNull();
      expect(pending.json()).toMatchObject({ status: PaymentStatus.PENDING, paidAt: null });
    });

    it('stores a retroactive paidAt inside the requested civil day (Sao Paulo)', async () => {
      const ctx = await setup();
      const paidDay = businessDayString(-10);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: paidDay,
      });

      expect(res.statusCode).toBe(200);
      const stored = await prisma.subscriptionPayment.findUnique({ where: { id: ctx.firstPaymentId } });
      expect(stored.paidAt.toISOString()).toBe(`${paidDay}T15:00:00.000Z`);
    });

    it('accepts paidAt = today', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(0),
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects a future paidAt with 400 SUBSCRIPTION_INVALID_PAID_AT', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(1),
      });

      expect(res.statusCode).toBe(400);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.INVALID_PAID_AT,
        messageCode: SubscriptionMessageCode.INVALID_PAID_AT,
      });
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.PENDING);
    });

    it('rejects a malformed paidAt as 400 VALIDATION_ERROR', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: '10/05/2026',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
    });

    it('lets a voided payment be paid later (late settlement)', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(PaymentStatus.PAID);
    });

    it('is idempotent when an already paid payment is paid again without paidAt (keeps the original paidAt)', async () => {
      const ctx = await setup();
      const first = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(-5),
      });

      const again = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      expect(again.statusCode).toBe(200);
      expect(again.json().paidAt).toBe(first.json().paidAt);
    });

    it('is idempotent when re-paid with the same civil paidAt day', async () => {
      const ctx = await setup();
      const paidDay = businessDayString(-5);
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, { paidAt: paidDay });

      const again = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: paidDay,
      });

      expect(again.statusCode).toBe(200);
    });

    it('answers 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID when an already paid payment is paid with a different paidAt', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(-5),
      });

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(-4),
      });

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
        messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
      });
      const stored = await prisma.subscriptionPayment.findUnique({ where: { id: ctx.firstPaymentId } });
      expect(stored.paidAt.toISOString()).toBe(`${businessDayString(-5)}T15:00:00.000Z`);
    });

    describe('paidAt lower bound (subscription start minus 12 months)', () => {
      const lowerBound = () =>
        addMonthsClamped(businessDay(-25), -PAID_AT_MAX_ADVANCE_MONTHS);

      it('accepts a paidAt exactly on the lower bound', async () => {
        const ctx = await setup({ startOffsetDays: -25 });

        const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
          paidAt: formatDateOnly(lowerBound()),
        });

        expect(res.statusCode).toBe(200);
      });

      it('rejects a paidAt one day before the lower bound with 400 SUBSCRIPTION_INVALID_PAID_AT', async () => {
        const ctx = await setup({ startOffsetDays: -25 });
        const dayBefore = new Date(lowerBound().getTime() - 86400000);

        const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
          paidAt: formatDateOnly(dayBefore),
        });

        expect(res.statusCode).toBe(400);
        expectUnifiedError(res.json(), {
          error: SubscriptionErrorCode.INVALID_PAID_AT,
          messageCode: SubscriptionMessageCode.INVALID_PAID_AT,
        });
        expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.PENDING);
      });
    });

    it('returns 404 when the payment does not exist', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/payments/${MISSING_ID}/mark-paid`, ctx.accessToken);

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe(SubscriptionErrorCode.PAYMENT_NOT_FOUND);
    });
  });

  describe('POST /trainer/payments/:id/mark-pending', () => {
    it('answers 409 SUBSCRIPTION_PAYMENT_CANCELLED for a voided payment', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-pending`, ctx.accessToken);

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.PAYMENT_CANCELLED,
        messageCode: SubscriptionMessageCode.PAYMENT_CANCELLED,
      });
    });
  });

  describe('mark-pending on payments of a cancelled subscription', () => {
    it('void future payment via cancel -> pay it -> mark-pending returns it to cancelled (not pending)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const future = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(20) });
      await post(`/trainer/subscriptions/${ctx.subscription.id}/cancel`, ctx.accessToken, {});
      expect(await paymentStatusInDb(future.id)).toBe(PaymentStatus.CANCELLED);

      const paid = await post(`/trainer/payments/${future.id}/mark-paid`, ctx.accessToken);
      const reverted = await post(`/trainer/payments/${future.id}/mark-pending`, ctx.accessToken);

      expect(paid.statusCode).toBe(200);
      expect(paid.json().status).toBe(PaymentStatus.PAID);
      expect(paid.json().voidedAt).toEqual(expect.any(String));
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ status: PaymentStatus.CANCELLED, paidAt: null });
      expect(await paymentStatusInDb(future.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('manual void -> pay late -> mark-pending returns it to cancelled (voidedAt survives the late payment)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      const payment = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-1) });
      const voided = await post(`/trainer/payments/${payment.id}/void`, ctx.accessToken);
      expect(voided.statusCode).toBe(200);
      expect((await prisma.subscriptionPayment.findUnique({ where: { id: payment.id } })).voidedAt).not.toBeNull();

      const paid = await post(`/trainer/payments/${payment.id}/mark-paid`, ctx.accessToken);
      const reverted = await post(`/trainer/payments/${payment.id}/mark-pending`, ctx.accessToken);

      expect(paid.json().status).toBe(PaymentStatus.PAID);
      expect(paid.json().voidedAt).toEqual(voided.json().voidedAt);
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ status: PaymentStatus.CANCELLED, paidAt: null });
      expect(await paymentStatusInDb(payment.id)).toBe(PaymentStatus.CANCELLED);
    });

    it('a never-voided paid payment reverts to pending', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      const reverted = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-pending`, ctx.accessToken);

      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ status: PaymentStatus.PENDING, paidAt: null });
    });

    it('mark-pending on a voided (cancelled) payment answers 409 SUBSCRIPTION_PAYMENT_CANCELLED', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-pending`, ctx.accessToken);

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.PAYMENT_CANCELLED,
        messageCode: SubscriptionMessageCode.PAYMENT_CANCELLED,
      });
    });

    it('a due (past) payment of a cancelled subscription reverts to pending', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/subscriptions/${ctx.subscription.id}/cancel`, ctx.accessToken, {});
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      const reverted = await post(`/trainer/payments/${ctx.firstPaymentId}/mark-pending`, ctx.accessToken);

      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ status: PaymentStatus.PENDING, paidAt: null });
    });
  });

  describe('concurrency on a single payment', () => {
    it('mark-paid racing a void never produces a 5xx and the stored status matches the winning responses', async () => {
      const ctx = await setup({ startOffsetDays: -25 });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const payment = await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-1) });

        const [paid, voided] = await Promise.all([
          post(`/trainer/payments/${payment.id}/mark-paid`, ctx.accessToken),
          post(`/trainer/payments/${payment.id}/void`, ctx.accessToken),
        ]);

        expect(paid.statusCode).toBeLessThan(500);
        expect(voided.statusCode).toBeLessThan(500);
        // Paying is allowed from pending and from cancelled, so the pay request always succeeds.
        expect(paid.statusCode).toBe(200);
        // Void either ran first (200, then paid overwrote the voided row) or lost to the payment (409).
        expect([200, 409]).toContain(voided.statusCode);
        if (voided.statusCode === 409) {
          expectUnifiedError(voided.json(), {
            error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
            messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
          });
        }
        expect(await paymentStatusInDb(payment.id)).toBe(PaymentStatus.PAID);
      }
    });

    it('two simultaneous mark-paid requests both answer 200 and leave a single consistent paid row', async () => {
      const ctx = await setup({ startOffsetDays: -25 });

      const results = await Promise.all([
        post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken),
        post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken),
      ]);

      expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.PAID);
    });
  });

  describe('cycle generator write guard', () => {
    const today = () => todayInBusinessTz(new Date());

    it('does not insert cycles for a cancelled subscription (insert helper and generator)', async () => {
      const ctx = await setup({ startOffsetDays: -27 });
      await post(`/trainer/subscriptions/${ctx.subscription.id}/cancel`, ctx.accessToken, {});
      const before = await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } });

      const bounds = computeCycleBounds(businessDay(-27), SubscriptionRecurrence.MONTHLY, 1);
      const inserted = await insertCyclesForActiveSubscriptions(prisma, [
        {
          subscriptionId: ctx.subscription.id,
          cycleIndex: 1,
          cycleStartDate: bounds.cycleStartDate,
          cycleEndDate: bounds.cycleEndDate,
          dueDate: bounds.cycleStartDate,
          amount: new Prisma.Decimal('100.00'),
          notes: null,
        },
      ]);
      const generated = await ensureUpcomingCycles(prisma, { trainerId: ctx.trainerId, today: today() });

      expect(inserted).toBe(0);
      expect(generated.cyclesCreated).toBe(0);
      expect(
        await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } }),
      ).toBe(before);
    });

    it('is idempotent: a second generator run creates nothing', async () => {
      const ctx = await setup({ startOffsetDays: -27 });

      const first = await ensureUpcomingCycles(prisma, { trainerId: ctx.trainerId, today: today() });
      const second = await ensureUpcomingCycles(prisma, { trainerId: ctx.trainerId, today: today() });

      expect(first.cyclesCreated).toBeGreaterThanOrEqual(1);
      expect(second.cyclesCreated).toBe(0);
    });

    it('cancel racing the generator never leaves a pending future charge on the cancelled subscription', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // -27 days monthly: the next grid cycle starts a few days from now (inside the 7-day lead window).
        const ctx = await setup({ startOffsetDays: -27 });

        const [cancelRes] = await Promise.all([
          post(`/trainer/subscriptions/${ctx.subscription.id}/cancel`, ctx.accessToken, {}),
          ensureUpcomingCycles(prisma, { trainerId: ctx.trainerId, today: today() }),
        ]);

        expect(cancelRes.statusCode).toBe(200);
        const stalePending = await prisma.subscriptionPayment.count({
          where: {
            subscriptionId: ctx.subscription.id,
            status: PaymentStatus.PENDING,
            cycleStartDate: { gt: today() },
          },
        });
        expect(stalePending).toBe(0);
      }
    });
  });

  // ─── void / delete alias ───────────────────────────────────────────────────

  describe('POST /trainer/payments/:id/void', () => {
    it('voids a pending payment and returns it (status cancelled, row kept)', async () => {
      const ctx = await setup();

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: ctx.firstPaymentId,
        status: PaymentStatus.CANCELLED,
        effectiveStatus: EffectivePaymentStatus.CANCELLED,
        daysOverdue: 0,
      });
      expect(res.json().voidedAt).toEqual(expect.any(String));
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.CANCELLED);
    });

    it('is idempotent on an already voided payment', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(PaymentStatus.CANCELLED);
    });

    it('refuses to void a paid payment with 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/void`, ctx.accessToken);

      expect(res.statusCode).toBe(409);
      expectUnifiedError(res.json(), {
        error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
        messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
      });
    });

    it('returns 404 for a payment of another trainer', async () => {
      const ctx = await setup();
      const other = await createTrainer(app);

      const res = await post(`/trainer/payments/${ctx.firstPaymentId}/void`, other.accessToken);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /trainer/payments/:id (alias of void)', () => {
    const del = (ctx, id) =>
      app.inject({
        method: 'DELETE',
        url: `/trainer/payments/${id}`,
        headers: authHeader(ctx.accessToken),
      });

    it('answers 204 and soft-voids the payment (row is NOT deleted)', async () => {
      const ctx = await setup();

      const res = await del(ctx, ctx.firstPaymentId);

      expect(res.statusCode).toBe(204);
      expect(await paymentStatusInDb(ctx.firstPaymentId)).toBe(PaymentStatus.CANCELLED);
    });

    it('answers 409 for a paid payment', async () => {
      const ctx = await setup();
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);

      const res = await del(ctx, ctx.firstPaymentId);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(SubscriptionErrorCode.PAYMENT_ALREADY_PAID);
    });

    it('answers 404 for an unknown payment', async () => {
      const ctx = await setup();

      expect((await del(ctx, MISSING_ID)).statusCode).toBe(404);
    });
  });

  // ─── Student payment history ───────────────────────────────────────────────

  describe('GET /trainer/students/:studentId/payments', () => {
    const history = (token, studentId) =>
      app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/payments`,
        headers: authHeader(token),
      });

    it('returns payments across subscriptions plus a summary of received money', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken, {
        paidAt: businessDayString(-3),
      });
      await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(10) });

      const res = await history(ctx.accessToken, ctx.studentId);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary).toEqual({
        totalReceived: '100.00',
        receivedCount: 1,
        customerSince: businessDayString(-25),
      });
      expect(body.payments).toHaveLength(2);
      body.payments.forEach((row) => expect(row.voidedAt).toBeNull());
      expect(body.student).toEqual({
        id: ctx.studentId,
        name: '', // fixture student signs up without a name
        avatarUrl: null,
      });
      expect(body.payments[0]).toMatchObject({
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        plan: { id: ctx.plan.id, name: ctx.plan.name },
      });
    });

    it('keeps working after the student is unlinked (history is not lost)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await post(`/trainer/payments/${ctx.firstPaymentId}/mark-paid`, ctx.accessToken);
      await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${ctx.studentId}`,
        headers: authHeader(ctx.accessToken),
      });

      const res = await history(ctx.accessToken, ctx.studentId);

      expect(res.statusCode).toBe(200);
      expect(res.json().summary.receivedCount).toBe(1);
      expect(res.json().payments[0].subscriptionStatus).toBe(SubscriptionStatus.CANCELLED);
      expect(res.json().student).toMatchObject({ id: ctx.studentId });
    });

    it('returns the student header for a linked student that has no payments yet', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app, { firstName: 'Maria' });
      await linkStudent(trainer.trainerId, student.userId);

      const res = await history(trainer.accessToken, student.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().student).toEqual({
        id: student.userId,
        name: 'Maria Teste',
        avatarUrl: null,
      });
      expect(res.json().payments).toEqual([]);
    });

    it('lists subscriptions of the student after unlink too (GET /trainer/students/:id/subscriptions)', async () => {
      const ctx = await setup({ startOffsetDays: -25 });
      await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${ctx.studentId}`,
        headers: authHeader(ctx.accessToken),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${ctx.studentId}/subscriptions`,
        headers: authHeader(ctx.accessToken),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });

    it('does not leak another trainer\'s payments (empty history)', async () => {
      const ctx = await setup();
      const other = await createTrainer(app);

      const res = await history(other.accessToken, ctx.studentId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        student: null,
        summary: { totalReceived: '0.00', receivedCount: 0, customerSince: null },
        payments: [],
      });
    });

    it('returns 401 without a token and 403 for a student', async () => {
      const ctx = await setup();
      const student = await createStudent(app);

      const unauthenticated = await app.inject({
        method: 'GET',
        url: `/trainer/students/${ctx.studentId}/payments`,
      });

      expect(unauthenticated.statusCode).toBe(401);
      expect((await history(student.accessToken, ctx.studentId)).statusCode).toBe(403);
    });
  });
  describe('billingDay-aligned cycles', () => {
    const START_OFFSET_DAYS = -25;
    const BILLING_DAY_OFFSET_DAYS = -27;

    async function setupWithBillingDay() {
      const billingDay = businessDay(BILLING_DAY_OFFSET_DAYS).getUTCDate();
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken, { billingDay });
      const assignRes = await assignPlanViaApi(
        app,
        trainer.accessToken,
        student.userId,
        plan.id,
        businessDayString(START_OFFSET_DAYS),
      );
      expect(assignRes.statusCode).toBe(201);
      expect(assignRes.json().billingDay).toBe(billingDay);
      return { ...trainer, billingDay, subscription: assignRes.json() };
    }

    it('assign bills the aligned cycle containing today with dueDate = startDate', async () => {
      const { billingDay, subscription } = await setupWithBillingDay();

      expect(subscription.billingDay).toBe(billingDay);
      expect(subscription.firstPayment).toMatchObject({
        cycleIndex: 0,
        cycleStartDate: businessDayString(BILLING_DAY_OFFSET_DAYS),
        dueDate: businessDayString(START_OFFSET_DAYS),
      });
    });

    it('manual next cycle follows the aligned grid with dueDate = cycle start', async () => {
      const { accessToken, billingDay, subscription } = await setupWithBillingDay();
      const expected = computeCycleBounds(
        businessDay(START_OFFSET_DAYS),
        SubscriptionRecurrence.MONTHLY,
        1,
        billingDay,
      );

      const res = await post(`/trainer/subscriptions/${subscription.id}/payments`, accessToken, {});

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        cycleIndex: 1,
        cycleStartDate: formatDateOnly(expected.cycleStartDate),
        cycleEndDate: formatDateOnly(expected.cycleEndDate),
        dueDate: formatDateOnly(expected.cycleStartDate),
      });
    });

    it('the cron generator creates the same next cycle from the stored billingDay', async () => {
      const { billingDay, subscription } = await setupWithBillingDay();
      const expected = computeCycleBounds(
        businessDay(START_OFFSET_DAYS),
        SubscriptionRecurrence.MONTHLY,
        1,
        billingDay,
      );

      await ensureUpcomingCycles(prisma, { today: todayInBusinessTz() });

      const created = await prisma.subscriptionPayment.findUnique({
        where: { subscriptionId_cycleIndex: { subscriptionId: subscription.id, cycleIndex: 1 } },
      });
      expect(formatDateOnly(created.cycleStartDate)).toBe(formatDateOnly(expected.cycleStartDate));
      expect(formatDateOnly(created.dueDate)).toBe(formatDateOnly(expected.cycleStartDate));
    });
  });

});

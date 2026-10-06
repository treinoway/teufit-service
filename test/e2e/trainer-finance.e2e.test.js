/**
 * E2E tests for GET /trainer/finance/overview (Financeiro).
 *
 * Fixtures are written directly through Prisma for exact control over
 * dueDate / paidAt / status boundaries. Dates relative to "today" use the
 * business timezone helper (same clock as the services); month-window tests
 * use fixed past months so they do not depend on when the suite runs.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  PaymentStatus,
  PAYMENT_OVERDUE_GRACE_DAYS,
  EffectivePaymentStatus,
  SubscriptionStatus,
  SubscriptionRecurrence,
} from '../../src/constants/subscription.js';
import { computeCycleBounds } from '../../src/helpers/subscription-helpers.js';
import {
  currentYearMonthInBusinessTz,
  formatDateOnly,
} from '../../src/helpers/date-helpers.js';
import {
  authHeader,
  businessDay,
  createPaymentRow,
  createPlanViaApi,
  createStudent,
  createSubscriptionRow,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PAST_MONTH = '2026-05';
// The overview materializes the current cycle of every active subscription. Rows seeded
// with a far-ahead cycleIndex make the generator add nothing, so KPI assertions only see seeded rows.
const GENERATOR_QUIET_CYCLE_INDEX = 1000;

function sumAmounts(rows) {
  return rows.reduce((total, row) => total + Math.round(Number(row.amount) * 100), 0) / 100;
}

e2eDescribe('e2e: GET /trainer/finance/overview', () => {
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

  const overview = (token, query = '') =>
    app.inject({
      method: 'GET',
      url: `/trainer/finance/overview${query}`,
      headers: authHeader(token),
    });

  async function setupTrainerWithStudent({ subscriptionStatus = SubscriptionStatus.ACTIVE, startDate } = {}) {
    const trainer = await createTrainer(app);
    const student = await createStudent(app, { firstName: 'Maria' });
    await linkStudent(trainer.trainerId, student.userId);
    const plan = await createPlanViaApi(app, trainer.accessToken);
    const subscription = await createSubscriptionRow({
      trainerId: trainer.trainerId,
      studentId: student.userId,
      planId: plan.id,
      status: subscriptionStatus,
      startDate: startDate ?? businessDay(-60),
    });
    return { ...trainer, studentId: student.userId, plan, subscription };
  }

  // ─── Auth & validation ──────────────────────────────────────────────────────

  describe('auth and validation', () => {
    it('returns 401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/trainer/finance/overview' });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for a student', async () => {
      const student = await createStudent(app);

      const res = await overview(student.accessToken);

      expect(res.statusCode).toBe(403);
    });

    it.each([['2026-13'], ['2026-00'], ['2026-6'], ['junho'], ['2026-06-01']])(
      'rejects month=%s with 400 VALIDATION_ERROR',
      async (month) => {
        const trainer = await createTrainer(app);

        const res = await overview(trainer.accessToken, `?month=${month}`);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
        });
        expect(Array.isArray(res.json().details)).toBe(true);
      },
    );

    it('defaults to the current Sao Paulo month and returns an empty, zeroed overview', async () => {
      const trainer = await createTrainer(app);

      const res = await overview(trainer.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        month: currentYearMonthInBusinessTz(new Date()),
        overdueGraceDays: PAYMENT_OVERDUE_GRACE_DAYS,
        kpis: {
          receivedAmount: '0.00',
          receivedCount: 0,
          pendingAmount: '0.00',
          pendingCount: 0,
          overdueAmount: '0.00',
          overdueCount: 0,
          overdueStudents: 0,
          billedStudents: 0,
          delinquencyRate: 0,
        },
        payments: [],
      });
    });
  });

  // ─── Row scope & KPIs ──────────────────────────────────────────────────────

  describe('rows and KPIs', () => {
    it('KPIs equal the sums over the returned rows, per effective status', async () => {
      const ctx = await setupTrainerWithStudent();
      const otherStudent = await createStudent(app, { firstName: 'Joao' });
      await linkStudent(ctx.trainerId, otherStudent.userId);
      const otherSub = await createSubscriptionRow({
        trainerId: ctx.trainerId,
        studentId: otherStudent.userId,
        planId: ctx.plan.id,
      });
      const sub = ctx.subscription.id;
      await createPaymentRow(sub, { dueDate: businessDay(-30), status: PaymentStatus.PAID, paidAt: new Date(), amount: 120.5 });
      await createPaymentRow(sub, { dueDate: businessDay(-10), amount: 80.25 }); // overdue
      await createPaymentRow(sub, { dueDate: businessDay(-3), amount: 40 }); // grace -> pending
      await createPaymentRow(otherSub.id, { dueDate: businessDay(-4), amount: 10.1 }); // overdue
      await createPaymentRow(otherSub.id, { dueDate: businessDay(0), amount: 33.33 }); // pending
      await createPaymentRow(otherSub.id, { dueDate: businessDay(-20), status: PaymentStatus.CANCELLED, amount: 999 }); // voided

      const res = await overview(ctx.accessToken);

      expect(res.statusCode).toBe(200);
      const { kpis, payments } = res.json();
      const by = (status) => payments.filter((row) => row.effectiveStatus === status);
      expect(payments.some((row) => row.status === PaymentStatus.CANCELLED)).toBe(false);
      expect(kpis.receivedCount).toBe(by(EffectivePaymentStatus.PAID).length);
      expect(Number(kpis.receivedAmount)).toBe(sumAmounts(by(EffectivePaymentStatus.PAID)));
      expect(kpis.pendingCount).toBe(by(EffectivePaymentStatus.PENDING).length);
      expect(Number(kpis.pendingAmount)).toBe(sumAmounts(by(EffectivePaymentStatus.PENDING)));
      expect(kpis.overdueCount).toBe(by(EffectivePaymentStatus.OVERDUE).length);
      expect(Number(kpis.overdueAmount)).toBe(sumAmounts(by(EffectivePaymentStatus.OVERDUE)));
      // And the concrete expected values for this fixture:
      expect(kpis).toMatchObject({
        receivedAmount: '120.50',
        receivedCount: 1,
        pendingAmount: '73.33',
        pendingCount: 2,
        overdueAmount: '90.35',
        overdueCount: 2,
        overdueStudents: 2,
        billedStudents: 2,
        delinquencyRate: 100,
      });
    });

    it('shapes each row with student, plan, subscriptionStatus, effectiveStatus and daysOverdue', async () => {
      const ctx = await setupTrainerWithStudent();
      await createPaymentRow(ctx.subscription.id, {
        dueDate: businessDay(-10),
        cycleIndex: GENERATOR_QUIET_CYCLE_INDEX,
      });

      const res = await overview(ctx.accessToken);

      const [row] = res.json().payments;
      expect(row).toMatchObject({
        subscriptionId: ctx.subscription.id,
        dueDate: formatDateOnly(businessDay(-10)),
        status: PaymentStatus.PENDING,
        effectiveStatus: EffectivePaymentStatus.OVERDUE,
        daysOverdue: 10,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        voidedAt: null,
        student: { id: ctx.studentId, name: expect.stringContaining('Maria'), avatarUrl: null },
        plan: { id: ctx.plan.id, name: ctx.plan.name, recurrence: SubscriptionRecurrence.MONTHLY },
      });
    });

    it('applies the 3-day grace window exactly: due today-3 stays pending, today-4 is overdue', async () => {
      const ctx = await setupTrainerWithStudent();
      await createPaymentRow(ctx.subscription.id, {
        dueDate: businessDay(-3),
        amount: 10,
        cycleIndex: GENERATOR_QUIET_CYCLE_INDEX,
      });
      await createPaymentRow(ctx.subscription.id, {
        dueDate: businessDay(-4),
        amount: 20,
        cycleIndex: GENERATOR_QUIET_CYCLE_INDEX + 1,
      });

      const { kpis } = (await overview(ctx.accessToken)).json();

      expect(kpis).toMatchObject({
        pendingCount: 1,
        pendingAmount: '10.00',
        overdueCount: 1,
        overdueAmount: '20.00',
      });
    });

    it('keeps overdue debt of a CANCELLED subscription visible, even when browsing another month', async () => {
      const ctx = await setupTrainerWithStudent({ subscriptionStatus: SubscriptionStatus.CANCELLED });
      await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-70), amount: 250 });

      const current = (await overview(ctx.accessToken)).json();
      const pastMonth = (await overview(ctx.accessToken, `?month=${PAST_MONTH}`)).json();

      for (const body of [current, pastMonth]) {
        expect(body.kpis).toMatchObject({ overdueCount: 1, overdueAmount: '250.00' });
        expect(body.payments[0].subscriptionStatus).toBe(SubscriptionStatus.CANCELLED);
      }
    });

    it('lists pending payments due up to the end of the requested month, not those of later months', async () => {
      const ctx = await setupTrainerWithStudent({ subscriptionStatus: SubscriptionStatus.CANCELLED });
      const futureDue = businessDay(75);
      const futureMonth = formatDateOnly(futureDue).slice(0, 7);
      await createPaymentRow(ctx.subscription.id, { dueDate: futureDue, amount: 55 });

      const current = (await overview(ctx.accessToken)).json();
      const future = (await overview(ctx.accessToken, `?month=${futureMonth}`)).json();

      expect(current.payments).toHaveLength(0);
      expect(future.payments).toHaveLength(1);
      expect(future.kpis).toMatchObject({ pendingCount: 1, pendingAmount: '55.00' });
    });

    it('never lists voided payments', async () => {
      const ctx = await setupTrainerWithStudent({ subscriptionStatus: SubscriptionStatus.CANCELLED });
      await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-20), status: PaymentStatus.CANCELLED });

      const body = (await overview(ctx.accessToken)).json();

      expect(body.payments).toEqual([]);
    });

    it('computes delinquencyRate as overdue students / billed students (percent, 2 dp)', async () => {
      const ctx = await setupTrainerWithStudent({ subscriptionStatus: SubscriptionStatus.CANCELLED });
      await createPaymentRow(ctx.subscription.id, { dueDate: businessDay(-10) });
      for (let index = 0; index < 2; index += 1) {
        const student = await createStudent(app);
        await linkStudent(ctx.trainerId, student.userId);
        const sub = await createSubscriptionRow({
          trainerId: ctx.trainerId,
          studentId: student.userId,
          planId: ctx.plan.id,
          status: SubscriptionStatus.CANCELLED,
        });
        await createPaymentRow(sub.id, { dueDate: businessDay(0) });
      }

      const { kpis } = (await overview(ctx.accessToken)).json();

      expect(kpis).toMatchObject({ billedStudents: 3, overdueStudents: 1, delinquencyRate: 33.33 });
    });

    it('does not leak payments of another trainer', async () => {
      const mine = await setupTrainerWithStudent();
      await createPaymentRow(mine.subscription.id, { dueDate: businessDay(-10) });
      const other = await createTrainer(app);

      const body = (await overview(other.accessToken)).json();

      expect(body.payments).toEqual([]);
      expect(body.kpis.overdueCount).toBe(0);
    });
  });

  // ─── Month window (America/Sao_Paulo) ──────────────────────────────────────

  describe('month window in the Sao Paulo timezone', () => {
    async function seedBoundaryPayments() {
      const ctx = await setupTrainerWithStudent({ subscriptionStatus: SubscriptionStatus.CANCELLED });
      const base = { status: PaymentStatus.PAID, dueDate: new Date('2026-05-10T00:00:00Z') };
      const lastMinuteOfMay = await createPaymentRow(ctx.subscription.id, {
        ...base,
        paidAt: new Date('2026-05-31T23:30:00-03:00'), // 02:30Z on Jun 1 — UTC says June
        amount: 100,
      });
      const firstMinuteOfJune = await createPaymentRow(ctx.subscription.id, {
        ...base,
        paidAt: new Date('2026-06-01T00:00:00-03:00'),
        amount: 200,
      });
      const firstMinuteOfMay = await createPaymentRow(ctx.subscription.id, {
        ...base,
        paidAt: new Date('2026-05-01T00:00:00-03:00'), // 03:00Z on May 1
        amount: 300,
      });
      const lastMinuteOfApril = await createPaymentRow(ctx.subscription.id, {
        ...base,
        paidAt: new Date('2026-04-30T23:59:00-03:00'),
        amount: 400,
      });
      return { ctx, lastMinuteOfMay, firstMinuteOfJune, firstMinuteOfMay, lastMinuteOfApril };
    }

    it('counts a payment paid 23:30 BRT on May 31 in MAY (even though UTC is already June)', async () => {
      const seeded = await seedBoundaryPayments();

      const may = (await overview(seeded.ctx.accessToken, '?month=2026-05')).json();
      const ids = may.payments.map((row) => row.id);

      expect(ids).toContain(seeded.lastMinuteOfMay.id);
      expect(ids).toContain(seeded.firstMinuteOfMay.id);
      expect(ids).not.toContain(seeded.firstMinuteOfJune.id);
      expect(ids).not.toContain(seeded.lastMinuteOfApril.id);
      expect(may.kpis).toMatchObject({ receivedCount: 2, receivedAmount: '400.00' });
    });

    it('counts a payment paid 00:00 BRT on June 1 in JUNE and none of the May ones', async () => {
      const seeded = await seedBoundaryPayments();

      const june = (await overview(seeded.ctx.accessToken, '?month=2026-06')).json();

      expect(june.payments.map((row) => row.id)).toEqual([seeded.firstMinuteOfJune.id]);
      expect(june.kpis).toMatchObject({ receivedCount: 1, receivedAmount: '200.00' });
    });

    it('counts a payment paid 23:59 BRT on April 30 in APRIL', async () => {
      const seeded = await seedBoundaryPayments();

      const april = (await overview(seeded.ctx.accessToken, '?month=2026-04')).json();

      expect(april.payments.map((row) => row.id)).toEqual([seeded.lastMinuteOfApril.id]);
    });
  });

  // ─── Cycle generation ──────────────────────────────────────────────────────

  describe('upcoming cycle generation', () => {
    it('materializes only the current/upcoming grid cycles of a stale subscription (no burst of past charges) and is idempotent', async () => {
      const startDate = businessDay(-70);
      const ctx = await setupTrainerWithStudent({ startDate });
      expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } })).toBe(0);

      const first = (await overview(ctx.accessToken)).json();
      const cyclesAfterFirst = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: ctx.subscription.id },
        orderBy: { cycleIndex: 'asc' },
      });
      const second = (await overview(ctx.accessToken)).json();
      const countAfterSecond = await prisma.subscriptionPayment.count({
        where: { subscriptionId: ctx.subscription.id },
      });

      expect(cyclesAfterFirst.length).toBeGreaterThanOrEqual(1);
      expect(cyclesAfterFirst.length).toBeLessThanOrEqual(2);
      expect(countAfterSecond).toBe(cyclesAfterFirst.length);
      expect(second.payments.map((row) => row.id)).toEqual(first.payments.map((row) => row.id));
      cyclesAfterFirst.forEach((cycle) => {
        const grid = computeCycleBounds(startDate, SubscriptionRecurrence.MONTHLY, cycle.cycleIndex);
        expect(cycle.cycleStartDate).toEqual(grid.cycleStartDate);
        expect(cycle.cycleEndDate).toEqual(grid.cycleEndDate);
        expect(cycle.cycleEndDate.getTime()).toBeGreaterThanOrEqual(businessDay(0).getTime());
        expect(cycle.cycleStartDate.getTime()).toBeLessThanOrEqual(businessDay(7).getTime());
      });
    });

    it('a subscription backdated one year (monthly) gets only the current cycle(s), not twelve past ones', async () => {
      const ctx = await setupTrainerWithStudent({ startDate: businessDay(-365) });

      await overview(ctx.accessToken);

      const cycles = await prisma.subscriptionPayment.findMany({
        where: { subscriptionId: ctx.subscription.id },
        orderBy: { cycleIndex: 'asc' },
      });
      expect(cycles.length).toBeLessThanOrEqual(2);
      expect(cycles[0].cycleIndex).toBeGreaterThanOrEqual(11); // grid index is preserved, past cycles skipped
      expect(cycles.every((cycle) => cycle.status === PaymentStatus.PENDING)).toBe(true);
    });

    it('never generates cycles for cancelled subscriptions', async () => {
      const ctx = await setupTrainerWithStudent({
        subscriptionStatus: SubscriptionStatus.CANCELLED,
        startDate: businessDay(-70),
      });

      await overview(ctx.accessToken);

      expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: ctx.subscription.id } })).toBe(0);
    });

    it('only generates for the requesting trainer (another trainer\'s subscriptions are untouched)', async () => {
      const mine = await setupTrainerWithStudent({ startDate: businessDay(-70) });
      const other = await setupTrainerWithStudent({ startDate: businessDay(-70) });

      await overview(mine.accessToken);

      expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: other.subscription.id } })).toBe(0);
      expect(
        await prisma.subscriptionPayment.count({ where: { subscriptionId: mine.subscription.id } }),
      ).toBeGreaterThan(0);
    });
  });

  // ─── Parity with the dashboard ─────────────────────────────────────────────

  describe('parity with GET /trainer/dashboard', () => {
    it('dashboard overdueCount/overdueAmount equal the overview overdue KPIs', async () => {
      const ctx = await setupTrainerWithStudent();
      const cancelledStudent = await createStudent(app);
      await linkStudent(ctx.trainerId, cancelledStudent.userId);
      const cancelled = await createSubscriptionRow({
        trainerId: ctx.trainerId,
        studentId: cancelledStudent.userId,
        planId: ctx.plan.id,
        status: SubscriptionStatus.CANCELLED,
      });
      const sub = ctx.subscription.id;
      await createPaymentRow(sub, { dueDate: businessDay(-30), amount: 100 });
      await createPaymentRow(sub, { dueDate: businessDay(-4), amount: 50.5 });
      await createPaymentRow(sub, { dueDate: businessDay(-3), amount: 70 }); // grace
      await createPaymentRow(sub, { dueDate: businessDay(-9), status: PaymentStatus.PAID, paidAt: new Date(), amount: 5 });
      await createPaymentRow(sub, { dueDate: businessDay(-9), status: PaymentStatus.CANCELLED, amount: 7 });
      await createPaymentRow(cancelled.id, { dueDate: businessDay(-45), amount: 12.34 });

      const overviewBody = (await overview(ctx.accessToken)).json();
      const dashboard = await app.inject({
        method: 'GET',
        url: '/trainer/dashboard',
        headers: authHeader(ctx.accessToken),
      });

      expect(dashboard.statusCode).toBe(200);
      const { finance } = dashboard.json();
      expect(finance.overdueCount).toBe(overviewBody.kpis.overdueCount);
      expect(finance.overdueAmount).toBe(overviewBody.kpis.overdueAmount);
      expect(finance.overdueCount).toBe(3);
      expect(finance.overdueAmount).toBe('162.84');
    });
  });
});

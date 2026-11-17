/**
 * E2E tests for /professional payment routes, finance overview and finance
 * summary (nutritionist-finance, AC 8-9).
 *
 * Fixtures are written through Prisma for exact control over dates/status.
 * Seeded payments use a far-ahead cycleIndex so the cycle generator that runs
 * before the overview adds nothing to the asserted rows.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  EffectivePaymentStatus,
  PaymentStatus,
  SubscriptionErrorCode,
  SubscriptionMessageCode,
} from '../../src/constants/subscription.js';
import {
  authHeader,
  businessDay,
  createPaymentRow,
  createPlanRow,
  createStudent,
  createSubscriptionRow,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import {
  createDualProfessional,
  createNutritionistProfessional,
  expectContractError,
  linkPatientRow,
} from '../helpers/professional-finance-e2e.js';
import { createUser } from '../helpers/nutrition-e2e.js';
import { ServiceType } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const GENERATOR_QUIET_CYCLE_INDEX = 1000;
const OVERDUE_DAYS_AGO = -10;

e2eDescribe('e2e: /professional payments, finance overview and summary', () => {
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

  const call = (method, token, url, payload) =>
    app.inject({ method, url, headers: authHeader(token), payload });

  async function seedNutritionSubscription(nutritionist) {
    const patient = await createStudent(app);
    await linkPatientRow(nutritionist.nutritionistId, patient.userId);
    const plan = await createPlanRow({ nutritionistId: nutritionist.nutritionistId, serviceType: ServiceType.NUTRITION });
    const subscription = await createSubscriptionRow({
      nutritionistId: nutritionist.nutritionistId,
      serviceType: ServiceType.NUTRITION,
      studentId: patient.userId,
      planId: plan.id,
    });
    return { patient, plan, subscription };
  }

  async function seedTrainingSubscription(trainerId) {
    const student = await createStudent(app);
    await linkStudent(trainerId, student.userId);
    const plan = await createPlanRow({ trainerId, serviceType: ServiceType.TRAINING });
    const subscription = await createSubscriptionRow({
      trainerId,
      serviceType: ServiceType.TRAINING,
      studentId: student.userId,
      planId: plan.id,
    });
    return { student, plan, subscription };
  }

  describe('AC 8: nutritionist payment routes behave like the trainer ones', () => {
    it('POST /professional/subscriptions/:id/payments generates the next cycle', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);

      const res = await call('POST', nutritionist.accessToken, `/professional/subscriptions/${subscription.id}/payments`, {});

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ subscriptionId: subscription.id, status: PaymentStatus.PENDING });
    });

    it('GET /professional/subscriptions/:id/payments lists the payments of the subscription', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const res = await call('GET', nutritionist.accessToken, `/professional/subscriptions/${subscription.id}/payments`);

      expect(res.statusCode).toBe(200);
      expect(res.json().map((item) => item.id)).toEqual([payment.id]);
    });

    it('PATCH /professional/payments/:id updates the notes', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const res = await call('PATCH', nutritionist.accessToken, `/professional/payments/${payment.id}`, { notes: 'Pix' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().notes).toBe('Pix');
    });

    it('marks a payment paid and back to pending', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const paid = await call('POST', nutritionist.accessToken, `/professional/payments/${payment.id}/mark-paid`, {});
      const reopened = await call('POST', nutritionist.accessToken, `/professional/payments/${payment.id}/mark-pending`);

      expect(paid.statusCode, paid.body).toBe(200);
      expect(paid.json()).toMatchObject({ status: PaymentStatus.PAID, paidAt: expect.any(String) });
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(reopened.json()).toMatchObject({ status: PaymentStatus.PENDING, paidAt: null });
    });

    it('POST /professional/payments/:id/void voids a pending payment', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const res = await call('POST', nutritionist.accessToken, `/professional/payments/${payment.id}/void`);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe(PaymentStatus.CANCELLED);
    });

    it('DELETE /professional/payments/:id answers 204 and voids the payment', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const res = await call('DELETE', nutritionist.accessToken, `/professional/payments/${payment.id}`);

      expect(res.statusCode).toBe(204);
      const row = await prisma.subscriptionPayment.findUnique({ where: { id: payment.id } });
      expect(row.status).toBe(PaymentStatus.CANCELLED);
    });

    it('voiding a paid payment answers 409 subscription.paymentAlreadyPaid', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);
      await call('POST', nutritionist.accessToken, `/professional/payments/${payment.id}/mark-paid`, {});

      const res = await call('POST', nutritionist.accessToken, `/professional/payments/${payment.id}/void`);

      expectContractError(res, {
        statusCode: 409,
        error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
        messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
      });
    });

    it('GET /professional/students/:studentId/payments returns the history with the serviceType of each payment', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { patient, subscription } = await seedNutritionSubscription(nutritionist);
      await createPaymentRow(subscription.id);

      const res = await call('GET', nutritionist.accessToken, `/professional/students/${patient.userId}/payments`);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().payments).toEqual([
        expect.objectContaining({ serviceType: ServiceType.NUTRITION, serviceTypeLabel: expect.any(String) }),
      ]);
    });

    it.each([
      ['PATCH', (id) => `/professional/payments/${id}`, { notes: 'x' }],
      ['POST', (id) => `/professional/payments/${id}/mark-paid`, {}],
      ['POST', (id) => `/professional/payments/${id}/mark-pending`, undefined],
      ['POST', (id) => `/professional/payments/${id}/void`, undefined],
      ['DELETE', (id) => `/professional/payments/${id}`, undefined],
    ])('%s %s answers 404 subscription.paymentNotFound for the payment of another professional', async (method, urlFor, payload) => {
      const owner = await createNutritionistProfessional(app);
      const intruder = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(owner);
      const payment = await createPaymentRow(subscription.id);

      const res = await call(method, intruder.accessToken, urlFor(payment.id), payload);

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PAYMENT_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PAYMENT_NOT_FOUND,
      });
      const untouched = await prisma.subscriptionPayment.findUnique({ where: { id: payment.id } });
      expect(untouched.status).toBe(PaymentStatus.PENDING);
    });

    it('a trainer cannot act on the payments of a nutritionist subscription', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const trainer = await createTrainer(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      const payment = await createPaymentRow(subscription.id);

      const res = await call('POST', trainer.accessToken, `/professional/payments/${payment.id}/mark-paid`, {});

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PAYMENT_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PAYMENT_NOT_FOUND,
      });
    });

    it('a dual-role user can act on payments of both owner rows', async () => {
      const dual = await createDualProfessional(app);
      const training = await seedTrainingSubscription(dual.trainerId);
      const nutrition = await seedNutritionSubscription(dual);
      const trainingPayment = await createPaymentRow(training.subscription.id);
      const nutritionPayment = await createPaymentRow(nutrition.subscription.id);

      const first = await call('POST', dual.accessToken, `/professional/payments/${trainingPayment.id}/mark-paid`, {});
      const second = await call('POST', dual.accessToken, `/professional/payments/${nutritionPayment.id}/mark-paid`, {});

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    });
  });

  describe('AC 9: GET /professional/finance/overview', () => {
    it('covers payments of both owner rows and tags each with its serviceType', async () => {
      const dual = await createDualProfessional(app);
      const training = await seedTrainingSubscription(dual.trainerId);
      const nutrition = await seedNutritionSubscription(dual);
      await createPaymentRow(training.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(0) });
      await createPaymentRow(nutrition.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(0) });

      const res = await call('GET', dual.accessToken, '/professional/finance/overview');

      expect(res.statusCode, res.body).toBe(200);
      const { payments } = res.json();
      expect(payments.map((payment) => payment.serviceType).sort()).toEqual(
        [ServiceType.NUTRITION, ServiceType.TRAINING].sort(),
      );
      payments.forEach((payment) => expect(payment.serviceTypeLabel).toEqual(expect.any(String)));
    });

    it('sums the KPIs across the trainer and nutritionist rows', async () => {
      const dual = await createDualProfessional(app);
      const training = await seedTrainingSubscription(dual.trainerId);
      const nutrition = await seedNutritionSubscription(dual);
      await createPaymentRow(training.subscription.id, {
        cycleIndex: GENERATOR_QUIET_CYCLE_INDEX,
        dueDate: businessDay(OVERDUE_DAYS_AGO),
        amount: '120.00',
      });
      await createPaymentRow(nutrition.subscription.id, {
        cycleIndex: GENERATOR_QUIET_CYCLE_INDEX,
        dueDate: businessDay(OVERDUE_DAYS_AGO),
        amount: '80.00',
      });

      const res = await call('GET', dual.accessToken, '/professional/finance/overview');

      expect(res.json().kpis).toMatchObject({ overdueCount: 2, overdueAmount: '200.00', overdueStudents: 2 });
      res.json().payments.forEach((payment) => expect(payment.effectiveStatus).toBe(EffectivePaymentStatus.OVERDUE));
    });

    it('does not include payments of another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const mine = await seedNutritionSubscription(nutritionist);
      const theirs = await seedNutritionSubscription(other);
      await createPaymentRow(mine.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX });
      await createPaymentRow(theirs.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX });

      const res = await call('GET', nutritionist.accessToken, '/professional/finance/overview');

      expect(res.json().payments.map((payment) => payment.student.id)).toEqual([mine.patient.userId]);
    });

    it('answers 400 validation.failed for a malformed month', async () => {
      const nutritionist = await createNutritionistProfessional(app);

      const res = await call('GET', nutritionist.accessToken, '/professional/finance/overview?month=2026-13');

      expectContractError(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('GET /professional/finance/summary', () => {
    it('returns overdueCount and overdueAmount for a nutritionist-only user', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const { subscription } = await seedNutritionSubscription(nutritionist);
      await createPaymentRow(subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(OVERDUE_DAYS_AGO), amount: '100.00' });
      await createPaymentRow(subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX + 1, dueDate: businessDay(OVERDUE_DAYS_AGO), amount: '50.50' });
      await createPaymentRow(subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX + 2, dueDate: businessDay(0), amount: '999.00' });

      const res = await call('GET', nutritionist.accessToken, '/professional/finance/summary');

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ overdueCount: 2, overdueAmount: '150.50' });
    });

    it('covers both owner rows of a dual-role user', async () => {
      const dual = await createDualProfessional(app);
      const training = await seedTrainingSubscription(dual.trainerId);
      const nutrition = await seedNutritionSubscription(dual);
      await createPaymentRow(training.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(OVERDUE_DAYS_AGO), amount: '10.00' });
      await createPaymentRow(nutrition.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(OVERDUE_DAYS_AGO), amount: '5.00' });

      const res = await call('GET', dual.accessToken, '/professional/finance/summary');

      expect(res.json()).toEqual({ overdueCount: 2, overdueAmount: '15.00' });
    });

    it('returns zeros when nothing is overdue and ignores other professionals', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const theirs = await seedNutritionSubscription(other);
      await createPaymentRow(theirs.subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(OVERDUE_DAYS_AGO) });

      const res = await call('GET', nutritionist.accessToken, '/professional/finance/summary');

      expect(res.json()).toEqual({ overdueCount: 0, overdueAmount: '0.00' });
    });

    it('answers 401 without a token and 403 for a user with neither role', async () => {
      const user = await createUser(app, 'plain');

      const anonymous = await app.inject({ method: 'GET', url: '/professional/finance/summary' });
      const plain = await call('GET', user.accessToken, '/professional/finance/summary');

      expect([anonymous.statusCode, plain.statusCode]).toEqual([401, 403]);
    });
  });
});

/**
 * E2E compatibility tests for /trainer/* billing next to /professional/*
 * (nutritionist-finance, AC 11-12): additive fields only, trainerId stays a uuid,
 * nutritionist-only users are still refused.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { PaymentStatus } from '../../src/constants/subscription.js';
import {
  assignPlanViaApi,
  authHeader,
  businessDay,
  businessDayString,
  createPaymentRow,
  createPlanViaApi,
  createStudent,
  createSubscriptionRow,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import {
  UUID_PATTERN,
  createDualProfessional,
  createNutritionistProfessional,
  createProfessionalPlan,
  linkPatientRow,
  assignProfessionalPlanOk,
} from '../helpers/professional-finance-e2e.js';
import { ServiceType } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const FORBIDDEN = 403;
const GENERATOR_QUIET_CYCLE_INDEX = 1000;

e2eDescribe('e2e: /trainer billing compatibility', () => {
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

  describe('AC 11: additive fields on /trainer/* responses', () => {
    it('adds serviceType training to a created plan while trainerId stays a uuid', async () => {
      const trainer = await createTrainer(app);

      const plan = await createPlanViaApi(app, trainer.accessToken);

      expect(plan).toMatchObject({ serviceType: ServiceType.TRAINING, serviceTypeLabel: expect.any(String) });
      expect(plan.trainerId).toMatch(UUID_PATTERN);
      expect(plan.trainerId).toBe(trainer.trainerId);
    });

    it('adds serviceType to the plan list items', async () => {
      const trainer = await createTrainer(app);
      await createPlanViaApi(app, trainer.accessToken);

      const res = await call('GET', trainer.accessToken, '/trainer/subscription-plans');

      expect(res.json()[0]).toMatchObject({ serviceType: ServiceType.TRAINING, serviceTypeLabel: expect.any(String) });
    });

    it('adds serviceType to the assigned subscription while trainerId stays a uuid', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);

      const res = await assignPlanViaApi(app, trainer.accessToken, student.userId, plan.id, businessDayString(0));

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ serviceType: ServiceType.TRAINING, serviceTypeLabel: expect.any(String) });
      expect(res.json().trainerId).toMatch(UUID_PATTERN);
    });

    it('adds serviceType to the finance overview payment rows', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);
      const subscription = await createSubscriptionRow({
        trainerId: trainer.trainerId,
        studentId: student.userId,
        planId: plan.id,
      });
      await createPaymentRow(subscription.id, { cycleIndex: GENERATOR_QUIET_CYCLE_INDEX, dueDate: businessDay(0) });

      const res = await call('GET', trainer.accessToken, '/trainer/finance/overview');

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().payments[0]).toMatchObject({ serviceType: ServiceType.TRAINING, serviceTypeLabel: expect.any(String) });
    });

    it('adds serviceType to the student payment history rows', async () => {
      const trainer = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);
      const subscription = await createSubscriptionRow({
        trainerId: trainer.trainerId,
        studentId: student.userId,
        planId: plan.id,
      });
      await createPaymentRow(subscription.id);

      const res = await call('GET', trainer.accessToken, `/trainer/students/${student.userId}/payments`);

      expect(res.json().payments[0]).toMatchObject({ serviceType: ServiceType.TRAINING });
    });

    it('keeps existing plan rows readable after the migration default (serviceType training)', async () => {
      const trainer = await createTrainer(app);
      const plan = await prisma.subscriptionPlan.create({
        data: { trainerId: trainer.trainerId, name: 'Legado', recurrence: 'monthly', price: 90 },
      });

      const res = await call('GET', trainer.accessToken, `/trainer/subscription-plans/${plan.id}`);

      expect(res.json()).toMatchObject({ id: plan.id, serviceType: ServiceType.TRAINING });
    });

    it('shows a dual-role user only trainer-owned rows on /trainer/* while /professional/* shows both', async () => {
      const dual = await createDualProfessional(app);
      await createProfessionalPlan(app, dual.accessToken, { name: 'T' });
      await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });

      const trainerView = await call('GET', dual.accessToken, '/trainer/subscription-plans');
      const professionalView = await call('GET', dual.accessToken, '/professional/subscription-plans');

      expect(trainerView.json().map((plan) => plan.name)).toEqual(['T']);
      expect(professionalView.json().map((plan) => plan.name).sort()).toEqual(['N', 'T']);
    });

    it('never exposes a null trainerId on /trainer/subscriptions for a dual-role user', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const nutritionPlan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.NUTRITION });
      await assignProfessionalPlanOk(app, dual.accessToken, person.userId, nutritionPlan.id, businessDayString(0));

      const res = await call('GET', dual.accessToken, '/trainer/subscriptions');

      expect(res.json()).toEqual([]);
    });
  });

  describe('AC 12: nutritionist-only user on /trainer/* billing routes', () => {
    it.each([
      ['GET', '/trainer/subscription-plans'],
      ['POST', '/trainer/subscription-plans'],
      ['GET', '/trainer/subscriptions'],
      ['GET', '/trainer/finance/overview'],
      ['GET', '/trainer/students/00000000-0000-4000-8000-000000000001/payments'],
      ['POST', '/trainer/payments/00000000-0000-4000-8000-000000000001/mark-paid'],
      ['POST', '/trainer/students/00000000-0000-4000-8000-000000000001/subscriptions'],
    ])('%s %s answers 403', async (method, url) => {
      const nutritionist = await createNutritionistProfessional(app);

      const res = await call(method, nutritionist.accessToken, url, method === 'POST' ? {} : undefined);

      expect(res.statusCode).toBe(FORBIDDEN);
    });

    it('does not let the nutritionist touch trainer payments through /trainer/*', async () => {
      const trainer = await createTrainer(app);
      const nutritionist = await createNutritionistProfessional(app);
      const student = await createStudent(app);
      await linkStudent(trainer.trainerId, student.userId);
      const plan = await createPlanViaApi(app, trainer.accessToken);
      const subscription = await createSubscriptionRow({
        trainerId: trainer.trainerId,
        studentId: student.userId,
        planId: plan.id,
      });
      const payment = await createPaymentRow(subscription.id);

      await call('POST', nutritionist.accessToken, `/trainer/payments/${payment.id}/mark-paid`, {});

      expect((await prisma.subscriptionPayment.findUnique({ where: { id: payment.id } })).status).toBe(PaymentStatus.PENDING);
    });
  });
});

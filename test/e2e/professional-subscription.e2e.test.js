/**
 * E2E tests for the /professional subscription routes (nutritionist-finance, AC 4-7).
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  CANCELLATION_REASON_REPLACED,
  PaymentStatus,
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import {
  authHeader,
  businessDayString,
  createStudent,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import { createLinkedPatient } from '../helpers/nutrition-e2e.js';
import {
  assignProfessionalPlan,
  assignProfessionalPlanOk,
  createDualProfessional,
  createNutritionistProfessional,
  createProfessionalPlan,
  expectContractError,
  linkPatientRow,
} from '../helpers/professional-finance-e2e.js';
import { ServiceType } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const FORBIDDEN = 403;

e2eDescribe('e2e: /professional subscriptions', () => {
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

  const today = () => businessDayString(0);
  const get = (token, url) => app.inject({ method: 'GET', url, headers: authHeader(token) });
  const activeCount = (studentId) =>
    prisma.studentSubscription.count({ where: { studentId, status: SubscriptionStatus.ACTIVE } });

  describe('AC 4: nutritionist assigns a nutrition plan', () => {
    it('creates the subscription and first payment owned by the nutritionist for a consented patient', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createLinkedPatient(app, nutritionist);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const body = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, plan.id, today());

      expect(body).toMatchObject({
        nutritionistId: nutritionist.nutritionistId,
        trainerId: null,
        studentId: patient.userId,
        planId: plan.id,
        serviceType: ServiceType.NUTRITION,
        serviceTypeLabel: expect.any(String),
        status: SubscriptionStatus.ACTIVE,
        firstPayment: { status: PaymentStatus.PENDING, cycleIndex: 0 },
      });
    });

    it('persists exactly one subscription and one payment', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const { id } = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, plan.id, today());

      expect(await prisma.studentSubscription.count({ where: { nutritionistId: nutritionist.nutritionistId } })).toBe(1);
      expect(await prisma.subscriptionPayment.count({ where: { subscriptionId: id } })).toBe(1);
    });

    it('answers 403 student.notLinked when the person is not a patient', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const stranger = await createStudent(app);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const res = await assignProfessionalPlan(app, nutritionist.accessToken, stranger.userId, plan.id, today());

      expectContractError(res, {
        statusCode: FORBIDDEN,
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
      expect(await prisma.studentSubscription.count()).toBe(0);
    });

    it('answers 403 student.notLinked once the patient link is soft-deleted', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      const link = await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      await prisma.nutritionistPatient.update({ where: { id: link.id }, data: { deletedAt: new Date() } });
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const res = await assignProfessionalPlan(app, nutritionist.accessToken, patient.userId, plan.id, today());

      expectContractError(res, {
        statusCode: FORBIDDEN,
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
    });

    it('answers 404 subscription.planNotFound for a plan of another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const foreignPlan = await createProfessionalPlan(app, other.accessToken);

      const res = await assignProfessionalPlan(app, nutritionist.accessToken, patient.userId, foreignPlan.id, today());

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PLAN_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      });
    });
  });

  describe('AC 5: both plan of a dual-role user', () => {
    it('succeeds for someone who is only their patient', async () => {
      const dual = await createDualProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(dual.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.BOTH });

      const body = await assignProfessionalPlanOk(app, dual.accessToken, patient.userId, plan.id, today());

      expect(body).toMatchObject({ trainerId: dual.trainerId, nutritionistId: null, serviceType: ServiceType.BOTH });
    });

    it('succeeds for someone who is only their student', async () => {
      const dual = await createDualProfessional(app);
      const student = await createStudent(app);
      await linkStudent(dual.trainerId, student.userId);
      const plan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.BOTH });

      const body = await assignProfessionalPlanOk(app, dual.accessToken, student.userId, plan.id, today());

      expect(body.serviceType).toBe(ServiceType.BOTH);
    });

    it('answers 403 student.notLinked when neither link exists', async () => {
      const dual = await createDualProfessional(app);
      const stranger = await createStudent(app);
      const plan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.BOTH });

      const res = await assignProfessionalPlan(app, dual.accessToken, stranger.userId, plan.id, today());

      expectContractError(res, {
        statusCode: FORBIDDEN,
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
    });

    it('does not let a training plan be assigned to someone who is only a patient', async () => {
      const dual = await createDualProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(dual.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.TRAINING });

      const res = await assignProfessionalPlan(app, dual.accessToken, patient.userId, plan.id, today());

      expectContractError(res, {
        statusCode: FORBIDDEN,
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
    });
  });

  describe('AC 6: independent professionals', () => {
    it('keeps both subscriptions active when nutritionist B assigns to a student of trainer A', async () => {
      const trainerA = await createTrainer(app);
      const nutritionistB = await createNutritionistProfessional(app);
      const person = await createStudent(app);
      await linkStudent(trainerA.trainerId, person.userId);
      await linkPatientRow(nutritionistB.nutritionistId, person.userId);
      const planA = await createProfessionalPlan(app, trainerA.accessToken);
      const planB = await createProfessionalPlan(app, nutritionistB.accessToken);

      const fromA = await assignProfessionalPlanOk(app, trainerA.accessToken, person.userId, planA.id, today());
      const fromB = await assignProfessionalPlanOk(app, nutritionistB.accessToken, person.userId, planB.id, today());

      const rows = await prisma.studentSubscription.findMany({ where: { id: { in: [fromA.id, fromB.id] } } });
      expect(rows.map((row) => row.status)).toEqual([SubscriptionStatus.ACTIVE, SubscriptionStatus.ACTIVE]);
    });
  });

  describe('AC 7: one active subscription per professional user', () => {
    it.each([ServiceType.TRAINING, ServiceType.BOTH])(
      'cancels the active nutrition subscription with reason replaced when a %s plan is assigned',
      async (newType) => {
        const dual = await createDualProfessional(app);
        const person = await createStudent(app);
        await linkStudent(dual.trainerId, person.userId);
        await linkPatientRow(dual.nutritionistId, person.userId);
        const nutritionPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });
        const newPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'New', serviceType: newType });
        const old = await assignProfessionalPlanOk(app, dual.accessToken, person.userId, nutritionPlan.id, today());

        const replacement = await assignProfessionalPlanOk(app, dual.accessToken, person.userId, newPlan.id, today());

        const oldRow = await prisma.studentSubscription.findUnique({ where: { id: old.id } });
        expect(oldRow).toMatchObject({
          status: SubscriptionStatus.CANCELLED,
          cancellationReason: CANCELLATION_REASON_REPLACED,
        });
        expect(replacement.status).toBe(SubscriptionStatus.ACTIVE);
        expect(await activeCount(person.userId)).toBe(1);
      },
    );

    it('replaces a training subscription when a nutrition plan is assigned to the same person', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const trainingPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'T' });
      const nutritionPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });
      const old = await assignProfessionalPlanOk(app, dual.accessToken, person.userId, trainingPlan.id, today());

      await assignProfessionalPlanOk(app, dual.accessToken, person.userId, nutritionPlan.id, today());

      const oldRow = await prisma.studentSubscription.findUnique({ where: { id: old.id } });
      expect(oldRow.status).toBe(SubscriptionStatus.CANCELLED);
      expect(await activeCount(person.userId)).toBe(1);
    });
  });

  describe('reads and cancel', () => {
    it('GET /professional/students/:studentId/subscriptions/active returns the nutrition subscription for its nutritionist', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);
      const created = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, plan.id, today());

      const res = await get(nutritionist.accessToken, `/professional/students/${patient.userId}/subscriptions/active`);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: created.id, serviceType: ServiceType.NUTRITION });
    });

    it('GET /professional/students/:studentId/subscriptions/active answers 403 student.notLinked for a stranger', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const stranger = await createStudent(app);

      const res = await get(nutritionist.accessToken, `/professional/students/${stranger.userId}/subscriptions/active`);

      expectContractError(res, {
        statusCode: FORBIDDEN,
        error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
        messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      });
    });

    it('GET /professional/students/:studentId/subscriptions lists the history of both owner rows', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const trainingPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'T' });
      const nutritionPlan = await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });
      await assignProfessionalPlanOk(app, dual.accessToken, person.userId, trainingPlan.id, today());
      await assignProfessionalPlanOk(app, dual.accessToken, person.userId, nutritionPlan.id, today());

      const res = await get(dual.accessToken, `/professional/students/${person.userId}/subscriptions`);

      expect(res.json().map((subscription) => subscription.serviceType).sort()).toEqual(
        [ServiceType.NUTRITION, ServiceType.TRAINING].sort(),
      );
    });

    it('GET /professional/subscriptions lists only the subscriptions of the caller', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      await linkPatientRow(other.nutritionistId, patient.userId);
      const mine = await createProfessionalPlan(app, nutritionist.accessToken);
      const theirs = await createProfessionalPlan(app, other.accessToken);
      const created = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, mine.id, today());
      await assignProfessionalPlanOk(app, other.accessToken, patient.userId, theirs.id, today());

      const res = await get(nutritionist.accessToken, '/professional/subscriptions');

      expect(res.json().map((subscription) => subscription.id)).toEqual([created.id]);
    });

    it('GET /professional/subscriptions/:id answers 404 subscription.notFound for another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(other.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, other.accessToken);
      const created = await assignProfessionalPlanOk(app, other.accessToken, patient.userId, plan.id, today());

      const res = await get(nutritionist.accessToken, `/professional/subscriptions/${created.id}`);

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
        messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
      });
    });

    it('POST /professional/subscriptions/:id/cancel cancels a nutritionist subscription', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);
      const created = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, plan.id, today());

      const res = await app.inject({
        method: 'POST',
        url: `/professional/subscriptions/${created.id}/cancel`,
        headers: authHeader(nutritionist.accessToken),
        payload: { reason: 'Alta' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: SubscriptionStatus.CANCELLED, cancellationReason: 'Alta' });
    });

    it('cancelling twice answers 409 subscription.cannotEditCancelled', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);
      const created = await assignProfessionalPlanOk(app, nutritionist.accessToken, patient.userId, plan.id, today());
      const cancel = () =>
        app.inject({
          method: 'POST',
          url: `/professional/subscriptions/${created.id}/cancel`,
          headers: authHeader(nutritionist.accessToken),
          payload: {},
        });
      await cancel();

      const res = await cancel();

      expectContractError(res, {
        statusCode: 409,
        error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
        messageCode: SubscriptionMessageCode.CANNOT_EDIT_CANCELLED,
      });
    });
  });
});

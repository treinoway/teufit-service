/**
 * E2E tests for voiding upcoming charges left on an already-replaced subscription when the person is unlinked
 * (nutritionist-finance, review finding M1), through DELETE /trainer/students/:studentId and
 * DELETE /nutritionist/patients/:patientId.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  CANCELLATION_REASON_REPLACED,
  PaymentStatus,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import {
  assignPlanViaApi,
  authHeader,
  businessDay,
  businessDayString,
  createPlanViaApi,
  createTrainer,
  createStudent,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import {
  assignProfessionalPlanOk,
  createNutritionistProfessional,
  createProfessionalPlan,
  linkPatientRow,
} from '../helpers/professional-finance-e2e.js';
import { ServiceType } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const NO_CONTENT = 204;
const REPLACEMENT_START_DAYS = 45;
const CREATED = 201;

e2eDescribe('e2e: unlink voids upcoming charges of a replaced subscription', () => {
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

  const unlinkPatient = (token, patientId) =>
    app.inject({ method: 'DELETE', url: `/nutritionist/patients/${patientId}`, headers: authHeader(token) });
  const unlinkStudent = (token, studentId) =>
    app.inject({ method: 'DELETE', url: `/trainer/students/${studentId}`, headers: authHeader(token) });

  const subscriptionRow = (id) => prisma.studentSubscription.findUnique({ where: { id } });
  const futurePayments = (subscriptionId) =>
    prisma.subscriptionPayment.findMany({
      where: { subscriptionId, cycleStartDate: { gt: businessDay(0) } },
      orderBy: { cycleIndex: 'asc' },
    });

  describe('trainer unlinks a student', () => {
    it('voids the future pending charge left on the replaced training subscription', async () => {
      const owner = await createTrainer(app);
      const student = await createStudent(app);
      await linkStudent(owner.trainerId, student.userId);
      const planA = await createPlanViaApi(app, owner.accessToken, { name: 'Plano A' });
      const planB = await createPlanViaApi(app, owner.accessToken, { name: 'Plano B' });
      const first = await assignPlanViaApi(app, owner.accessToken, student.userId, planA.id, businessDayString(0));
      expect(first.statusCode, first.body).toBe(CREATED);
      const second = await assignPlanViaApi(
        app,
        owner.accessToken,
        student.userId,
        planB.id,
        businessDayString(REPLACEMENT_START_DAYS),
      );
      expect(second.statusCode, second.body).toBe(CREATED);
      const subscriptionA = first.json();
      expect(await subscriptionRow(subscriptionA.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_REPLACED,
      });
      const pendingBefore = await futurePayments(subscriptionA.id);
      expect(pendingBefore.length).toBeGreaterThan(0);

      const res = await unlinkStudent(owner.accessToken, student.userId);

      expect(res.statusCode, res.body).toBe(NO_CONTENT);
      const after = await futurePayments(subscriptionA.id);
      expect(after.map((payment) => payment.status)).toEqual(after.map(() => PaymentStatus.CANCELLED));
      expect(after.every((payment) => payment.voidedAt instanceof Date)).toBe(true);
    });
  });

  describe('nutritionist unlinks a patient', () => {
    it('voids the future pending charge left on the replaced nutrition subscription', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const planA = await createProfessionalPlan(app, nutritionist.accessToken, {
        name: 'Plano A',
        serviceType: ServiceType.NUTRITION,
      });
      const planB = await createProfessionalPlan(app, nutritionist.accessToken, {
        name: 'Plano B',
        serviceType: ServiceType.NUTRITION,
      });
      const subscriptionA = await assignProfessionalPlanOk(
        app,
        nutritionist.accessToken,
        patient.userId,
        planA.id,
        businessDayString(0),
      );
      await assignProfessionalPlanOk(
        app,
        nutritionist.accessToken,
        patient.userId,
        planB.id,
        businessDayString(REPLACEMENT_START_DAYS),
      );
      expect(await subscriptionRow(subscriptionA.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_REPLACED,
      });
      const pendingBefore = await futurePayments(subscriptionA.id);
      expect(pendingBefore.length).toBeGreaterThan(0);

      const res = await unlinkPatient(nutritionist.accessToken, patient.userId);

      expect(res.statusCode, res.body).toBe(NO_CONTENT);
      const after = await futurePayments(subscriptionA.id);
      expect(after.map((payment) => payment.status)).toEqual(after.map(() => PaymentStatus.CANCELLED));
      expect(after.every((payment) => payment.voidedAt instanceof Date)).toBe(true);
    });
  });
});

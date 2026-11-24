/**
 * E2E tests for the billing cleanup on unlink (nutritionist-finance, AC 10),
 * through DELETE /nutritionist/patients/:patientId and DELETE /trainer/students/:studentId.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  CANCELLATION_REASON_UNLINKED,
  PaymentStatus,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import {
  authHeader,
  businessDay,
  createPaymentRow,
  createPlanRow,
  createStudent,
  createSubscriptionRow,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import {
  createDualProfessional,
  createNutritionistProfessional,
  linkPatientRow,
} from '../helpers/professional-finance-e2e.js';
import { ServiceType } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const NO_CONTENT = 204;
const FUTURE_DAYS = 20;
const DUE_DAYS_AGO = -5;

e2eDescribe('e2e: unlink billing cleanup', () => {
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

  async function seedSubscription({ owner, serviceType, studentId }) {
    const onNutritionist = serviceType === ServiceType.NUTRITION;
    const ownerColumns = onNutritionist
      ? { nutritionistId: owner.nutritionistId, trainerId: null }
      : { trainerId: owner.trainerId, nutritionistId: null };
    const plan = await createPlanRow({ ...ownerColumns, serviceType });
    const subscription = await createSubscriptionRow({ ...ownerColumns, serviceType, studentId, planId: plan.id });
    const due = await createPaymentRow(subscription.id, { cycleIndex: 0, dueDate: businessDay(DUE_DAYS_AGO) });
    const upcoming = await createPaymentRow(subscription.id, {
      cycleIndex: 1,
      dueDate: businessDay(FUTURE_DAYS),
      cycleStartDate: businessDay(FUTURE_DAYS),
    });
    return { subscription, due, upcoming };
  }

  const subscriptionRow = (id) => prisma.studentSubscription.findUnique({ where: { id } });
  const paymentRow = (id) => prisma.subscriptionPayment.findUnique({ where: { id } });

  describe('nutritionist unlinks a patient', () => {
    it('cancels the active nutrition subscription with reason unlinked and voids upcoming charges only', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      const seeded = await seedSubscription({ owner: nutritionist, serviceType: ServiceType.NUTRITION, studentId: patient.userId });

      const res = await unlinkPatient(nutritionist.accessToken, patient.userId);

      expect(res.statusCode, res.body).toBe(NO_CONTENT);
      expect(await subscriptionRow(seeded.subscription.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_UNLINKED,
      });
      expect(await paymentRow(seeded.upcoming.id)).toMatchObject({
        status: PaymentStatus.CANCELLED,
        voidedAt: expect.any(Date),
      });
      expect((await paymentRow(seeded.due.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('keeps a both subscription active while the trainer link remains', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const seeded = await seedSubscription({ owner: dual, serviceType: ServiceType.BOTH, studentId: person.userId });

      await unlinkPatient(dual.accessToken, person.userId);

      expect((await subscriptionRow(seeded.subscription.id)).status).toBe(SubscriptionStatus.ACTIVE);
      expect((await paymentRow(seeded.upcoming.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('cancels a both subscription once the last link is gone (patient unlinked after student)', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const seeded = await seedSubscription({ owner: dual, serviceType: ServiceType.BOTH, studentId: person.userId });

      await unlinkStudent(dual.accessToken, person.userId);
      await unlinkPatient(dual.accessToken, person.userId);

      expect(await subscriptionRow(seeded.subscription.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_UNLINKED,
      });
      expect((await paymentRow(seeded.upcoming.id)).status).toBe(PaymentStatus.CANCELLED);
    });

    it('leaves the training subscription of the same user untouched', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const training = await seedSubscription({ owner: dual, serviceType: ServiceType.TRAINING, studentId: person.userId });

      await unlinkPatient(dual.accessToken, person.userId);

      expect((await subscriptionRow(training.subscription.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('does not touch the subscription another professional holds with the same person', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const otherNutritionist = await createNutritionistProfessional(app);
      const patient = await createStudent(app);
      await linkPatientRow(nutritionist.nutritionistId, patient.userId);
      await linkPatientRow(otherNutritionist.nutritionistId, patient.userId);
      const theirs = await seedSubscription({ owner: otherNutritionist, serviceType: ServiceType.NUTRITION, studentId: patient.userId });

      await unlinkPatient(nutritionist.accessToken, patient.userId);

      expect((await subscriptionRow(theirs.subscription.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });
  });

  describe('trainer unlinks a student', () => {
    it('keeps a both subscription alive while the patient link remains', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const seeded = await seedSubscription({ owner: dual, serviceType: ServiceType.BOTH, studentId: person.userId });

      const res = await unlinkStudent(dual.accessToken, person.userId);

      expect(res.statusCode, res.body).toBe(NO_CONTENT);
      expect((await subscriptionRow(seeded.subscription.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('cancels the training subscription with reason unlinked and voids upcoming charges', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      const seeded = await seedSubscription({ owner: dual, serviceType: ServiceType.TRAINING, studentId: person.userId });

      await unlinkStudent(dual.accessToken, person.userId);

      expect(await subscriptionRow(seeded.subscription.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        cancellationReason: CANCELLATION_REASON_UNLINKED,
      });
      expect((await paymentRow(seeded.upcoming.id)).status).toBe(PaymentStatus.CANCELLED);
      expect((await paymentRow(seeded.due.id)).status).toBe(PaymentStatus.PENDING);
    });

    it('leaves a nutrition subscription of the same user untouched', async () => {
      const dual = await createDualProfessional(app);
      const person = await createStudent(app);
      await linkStudent(dual.trainerId, person.userId);
      await linkPatientRow(dual.nutritionistId, person.userId);
      const nutrition = await seedSubscription({ owner: dual, serviceType: ServiceType.NUTRITION, studentId: person.userId });

      await unlinkStudent(dual.accessToken, person.userId);

      expect((await subscriptionRow(nutrition.subscription.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });
  });
});

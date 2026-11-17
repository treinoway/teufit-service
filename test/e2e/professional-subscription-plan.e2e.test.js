/**
 * E2E tests for the /professional/subscription-plans routes (nutritionist-finance, AC 1-3).
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import {
  authHeader,
  createPlanRow,
  createStudent,
  createSubscriptionRow,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import { createUser } from '../helpers/nutrition-e2e.js';
import {
  UUID_PATTERN,
  createDualProfessional,
  createNutritionistProfessional,
  createProfessionalPlan,
  expectContractError,
  linkPatientRow,
  postProfessionalPlan,
} from '../helpers/professional-finance-e2e.js';
import { ServiceType, SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE } from '../helpers/subscription-owner-fixtures.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const UNPROCESSABLE = 422;

e2eDescribe('e2e: /professional/subscription-plans', () => {
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

  const get = (token, url) => app.inject({ method: 'GET', url, headers: authHeader(token) });
  const send = (method, token, url, payload) =>
    app.inject({ method, url, headers: authHeader(token), payload });

  describe('AC 1: nutritionist-only user creates a plan', () => {
    it('defaults to serviceType nutrition owned by the nutritionist row with trainerId null', async () => {
      const nutritionist = await createNutritionistProfessional(app);

      const res = await postProfessionalPlan(app, nutritionist.accessToken);

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        serviceType: ServiceType.NUTRITION,
        serviceTypeLabel: expect.any(String),
        nutritionistId: nutritionist.nutritionistId,
        trainerId: null,
        name: 'Plano Mensal',
        isArchived: false,
      });
    });

    it('persists the owner columns on the plan row', async () => {
      const nutritionist = await createNutritionistProfessional(app);

      const { id } = await createProfessionalPlan(app, nutritionist.accessToken);

      const row = await prisma.subscriptionPlan.findUnique({ where: { id } });
      expect(row).toMatchObject({
        serviceType: ServiceType.NUTRITION,
        nutritionistId: nutritionist.nutritionistId,
        trainerId: null,
      });
    });

    it('rejects a training plan with 422 subscription.serviceTypeNotAllowed', async () => {
      const nutritionist = await createNutritionistProfessional(app);

      const res = await postProfessionalPlan(app, nutritionist.accessToken, { serviceType: ServiceType.TRAINING });

      expectContractError(res, {
        statusCode: UNPROCESSABLE,
        messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
      });
    });
  });

  describe('AC 2: trainer-only user', () => {
    it('defaults to serviceType training owned by the trainer row with nutritionistId null', async () => {
      const trainer = await createTrainer(app);

      const res = await postProfessionalPlan(app, trainer.accessToken);

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        serviceType: ServiceType.TRAINING,
        trainerId: trainer.trainerId,
        nutritionistId: null,
      });
    });

    it.each([ServiceType.NUTRITION, ServiceType.BOTH])(
      'rejects serviceType %s with 422 subscription.serviceTypeNotAllowed and creates nothing',
      async (serviceType) => {
        const trainer = await createTrainer(app);

        const res = await postProfessionalPlan(app, trainer.accessToken, { serviceType });

        expectContractError(res, {
          statusCode: UNPROCESSABLE,
          messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
        });
        expect(await prisma.subscriptionPlan.count()).toBe(0);
      },
    );

    it('rejects an unknown serviceType with a 400 validation error', async () => {
      const trainer = await createTrainer(app);

      const res = await postProfessionalPlan(app, trainer.accessToken, { serviceType: 'wellness' });

      expectContractError(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('AC 3: dual-role user', () => {
    it('owns training and both plans by the trainer row and nutrition by the nutritionist row', async () => {
      const dual = await createDualProfessional(app);

      const training = await createProfessionalPlan(app, dual.accessToken, { name: 'T', serviceType: ServiceType.TRAINING });
      const both = await createProfessionalPlan(app, dual.accessToken, { name: 'B', serviceType: ServiceType.BOTH });
      const nutrition = await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });

      expect(training).toMatchObject({ trainerId: dual.trainerId, nutritionistId: null });
      expect(both).toMatchObject({ trainerId: dual.trainerId, nutritionistId: null });
      expect(nutrition).toMatchObject({ trainerId: null, nutritionistId: dual.nutritionistId });
    });

    it('defaults to training when no serviceType is sent', async () => {
      const dual = await createDualProfessional(app);

      const plan = await createProfessionalPlan(app, dual.accessToken);

      expect(plan.serviceType).toBe(ServiceType.TRAINING);
    });

    it('lists all three plans on GET /professional/subscription-plans', async () => {
      const dual = await createDualProfessional(app);
      await createProfessionalPlan(app, dual.accessToken, { name: 'T', serviceType: ServiceType.TRAINING });
      await createProfessionalPlan(app, dual.accessToken, { name: 'B', serviceType: ServiceType.BOTH });
      await createProfessionalPlan(app, dual.accessToken, { name: 'N', serviceType: ServiceType.NUTRITION });

      const res = await get(dual.accessToken, '/professional/subscription-plans');

      expect(res.statusCode).toBe(200);
      expect(res.json().map((plan) => plan.serviceType).sort()).toEqual(
        [ServiceType.BOTH, ServiceType.NUTRITION, ServiceType.TRAINING].sort(),
      );
    });

    it('does not leak plans of another professional', async () => {
      const dual = await createDualProfessional(app);
      const other = await createNutritionistProfessional(app);
      await createProfessionalPlan(app, other.accessToken, { name: 'Other' });
      await createProfessionalPlan(app, dual.accessToken, { name: 'Mine' });

      const res = await get(dual.accessToken, '/professional/subscription-plans');

      expect(res.json().map((plan) => plan.name)).toEqual(['Mine']);
    });
  });

  describe('GET /professional/subscription-plans activeSubscriptionCountByKind', () => {
    it('counts a subscriber linked to the owner as trainer as a student and otherwise as a patient', async () => {
      const dual = await createDualProfessional(app);
      const plan = await createProfessionalPlan(app, dual.accessToken, { serviceType: ServiceType.BOTH });
      const student = await createStudent(app);
      const patient = await createStudent(app);
      await linkStudent(dual.trainerId, student.userId);
      await linkPatientRow(dual.nutritionistId, patient.userId);
      await createSubscriptionRow({
        trainerId: dual.trainerId,
        serviceType: ServiceType.BOTH,
        studentId: student.userId,
        planId: plan.id,
      });
      await createSubscriptionRow({
        trainerId: dual.trainerId,
        serviceType: ServiceType.BOTH,
        studentId: patient.userId,
        planId: plan.id,
      });

      const res = await get(dual.accessToken, '/professional/subscription-plans');

      const listed = res.json().find((item) => item.id === plan.id);
      expect(listed.activeSubscriptionCount).toBe(2);
      expect(listed.activeSubscriptionCountByKind).toEqual({ students: 1, patients: 1 });
    });

    it('ignores cancelled subscriptions', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);
      const patient = await createStudent(app);
      await createSubscriptionRow({
        nutritionistId: nutritionist.nutritionistId,
        serviceType: ServiceType.NUTRITION,
        studentId: patient.userId,
        planId: plan.id,
        status: SubscriptionStatus.CANCELLED,
      });

      const res = await get(nutritionist.accessToken, '/professional/subscription-plans');

      expect(res.json()[0].activeSubscriptionCountByKind).toEqual({ students: 0, patients: 0 });
    });
  });

  describe('plan CRUD scoped to the owner', () => {
    it('GET /:id returns the plan with serviceType and a uuid nutritionistId', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const res = await get(nutritionist.accessToken, `/professional/subscription-plans/${plan.id}`);

      expect(res.statusCode).toBe(200);
      expect(res.json().nutritionistId).toMatch(UUID_PATTERN);
    });

    it('GET /:id answers 404 subscription.planNotFound for a plan of another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, other.accessToken);

      const res = await get(nutritionist.accessToken, `/professional/subscription-plans/${plan.id}`);

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PLAN_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      });
    });

    it('PATCH /:id updates the plan fields', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const res = await send('PATCH', nutritionist.accessToken, `/professional/subscription-plans/${plan.id}`, {
        name: 'Renomeado',
        price: 150,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Renomeado', price: '150.00', serviceType: ServiceType.NUTRITION });
    });

    it('PATCH /:id with a serviceType the owner may not use answers 422 subscription.serviceTypeNotAllowed', async () => {
      const trainer = await createTrainer(app);
      const plan = await createProfessionalPlan(app, trainer.accessToken);

      const res = await send('PATCH', trainer.accessToken, `/professional/subscription-plans/${plan.id}`, {
        serviceType: ServiceType.NUTRITION,
      });

      expectContractError(res, { statusCode: UNPROCESSABLE, messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE });
    });

    it('PATCH /:id answers 404 for a plan of another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, other.accessToken);

      const res = await send('PATCH', nutritionist.accessToken, `/professional/subscription-plans/${plan.id}`, { name: 'x' });

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PLAN_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      });
    });

    it('archives and unarchives a plan, hiding it from the default list while archived', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const plan = await createProfessionalPlan(app, nutritionist.accessToken);

      const archived = await send('POST', nutritionist.accessToken, `/professional/subscription-plans/${plan.id}/archive`);
      const hidden = await get(nutritionist.accessToken, '/professional/subscription-plans');
      const shown = await get(nutritionist.accessToken, '/professional/subscription-plans?includeArchived=true');
      const restored = await send('POST', nutritionist.accessToken, `/professional/subscription-plans/${plan.id}/unarchive`);

      expect(archived.json().isArchived).toBe(true);
      expect(hidden.json()).toEqual([]);
      expect(shown.json()).toHaveLength(1);
      expect(restored.json().isArchived).toBe(false);
    });

    it('archive answers 404 for a plan of another professional', async () => {
      const nutritionist = await createNutritionistProfessional(app);
      const other = await createNutritionistProfessional(app);
      const plan = await createPlanRow({ nutritionistId: other.nutritionistId, serviceType: ServiceType.NUTRITION });

      const res = await send('POST', nutritionist.accessToken, `/professional/subscription-plans/${plan.id}/archive`);

      expectContractError(res, {
        statusCode: 404,
        error: SubscriptionErrorCode.PLAN_NOT_FOUND,
        messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      });
    });
  });

  describe('authentication and roles', () => {
    it('answers 401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/professional/subscription-plans' });

      expect(res.statusCode).toBe(401);
    });

    it('answers 403 for a user with neither the trainer nor the nutritionist role', async () => {
      const user = await createUser(app, 'plain');

      const res = await get(user.accessToken, '/professional/subscription-plans');

      expect(res.statusCode).toBe(403);
    });

    it('answers 400 validation.failed for an invalid body', async () => {
      const nutritionist = await createNutritionistProfessional(app);

      const res = await postProfessionalPlan(app, nutritionist.accessToken, { price: -1 });

      expectContractError(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });
});

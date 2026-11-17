import { expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { createNutritionist } from './nutrition-e2e.js';
import { createTrainer, authHeader } from './billing-fixtures.js';
import { SubscriptionRecurrence } from '../../src/constants/subscription.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Nutritionist-only professional: { userId, accessToken, nutritionistId }.
export async function createNutritionistProfessional(app) {
  const nutritionist = await createNutritionist(app);
  const row = await prisma.nutritionist.findUnique({ where: { userId: nutritionist.userId }, select: { id: true } });
  return { userId: nutritionist.userId, accessToken: nutritionist.accessToken, nutritionistId: row.id };
}

// Dual-role professional (trainer first, then nutritionist): { userId, accessToken, trainerId, nutritionistId }.
export async function createDualProfessional(app) {
  const trainer = await createTrainer(app);
  const res = await app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: authHeader(trainer.accessToken) });
  expect(res.statusCode, res.body).toBe(200);
  const row = await prisma.nutritionist.findUnique({ where: { userId: trainer.userId }, select: { id: true } });
  return {
    userId: trainer.userId,
    trainerId: trainer.trainerId,
    nutritionistId: row.id,
    accessToken: res.json().token.accessToken,
  };
}

// Active nutritionist-patient link written straight to the database.
export async function linkPatientRow(nutritionistId, patientId) {
  return prisma.nutritionistPatient.create({ data: { nutritionistId, patientId } });
}

// POST /professional/subscription-plans, returns the raw response.
export function postProfessionalPlan(app, accessToken, overrides = {}) {
  return app.inject({
    method: 'POST',
    url: '/professional/subscription-plans',
    headers: authHeader(accessToken),
    payload: { name: 'Plano Mensal', recurrence: SubscriptionRecurrence.MONTHLY, price: 100, ...overrides },
  });
}

// Creates a plan through /professional/subscription-plans and returns its body (asserts 201).
export async function createProfessionalPlan(app, accessToken, overrides = {}) {
  const res = await postProfessionalPlan(app, accessToken, overrides);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

// POST /professional/students/:studentId/subscriptions, returns the raw response.
export function assignProfessionalPlan(app, accessToken, studentId, planId, startDate) {
  return app.inject({
    method: 'POST',
    url: `/professional/students/${studentId}/subscriptions`,
    headers: authHeader(accessToken),
    payload: { planId, startDate },
  });
}

// Assigns through /professional/* and returns the body (asserts 201).
export async function assignProfessionalPlanOk(app, accessToken, studentId, planId, startDate) {
  const res = await assignProfessionalPlan(app, accessToken, studentId, planId, startDate);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

// Asserts the unified error contract (status, error, messageCode, message; details only on validation errors).
export function expectContractError(res, { statusCode, error, messageCode }) {
  expect(res.statusCode, res.body).toBe(statusCode);
  const body = res.json();
  expect(body).toMatchObject({ error: error ?? expect.any(String), messageCode });
  expect(typeof body.message).toBe('string');
  return body;
}

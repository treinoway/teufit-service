import { expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { signupVerified } from './signup-user.js';

const PASSWORD = 'StrongPassw0rd!';
export const BIRTH_AGE_YEARS = 29;

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

let sequence = 0;

/** YYYY-MM-DD of today in America/Sao_Paulo shifted by offsetDays (the app day key). */
export function saoPauloDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE }).format(new Date());
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** Unique email per call. */
export function uniqueEmail(prefix) {
  sequence += 1;
  return `e2e+${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** Bearer header for a token. */
export function auth(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

/** Signs up a verified plain user: { userId, accessToken, email }. */
export async function createUser(app, prefix = 'user') {
  const email = uniqueEmail(prefix);
  const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const { user: { id: userId }, token: { accessToken } } = res.json();
  return { userId, accessToken, email };
}

/** Signs up a user and promotes to nutritionist: { userId, accessToken, email }. */
export async function createNutritionist(app) {
  const { userId, accessToken: rawToken, email } = await createUser(app, 'nutri');
  const res = await app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(rawToken) });
  expect(res.statusCode).toBe(200);
  return { userId, accessToken: res.json().token.accessToken, email };
}

/** Birth date (Date) that makes someone exactly BIRTH_AGE_YEARS old today, with margin. */
export function birthDateForAge(years = BIRTH_AGE_YEARS) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCMonth(date.getUTCMonth() - 2);
  date.setUTCDate(1);
  return date;
}

/** Nutritionist invites an email: POST /nutritionist/patient-invites. */
export function inviteByEmail(app, nutritionist, email) {
  return app.inject({
    method: 'POST',
    url: '/nutritionist/patient-invites',
    headers: auth(nutritionist.accessToken),
    payload: { email },
  });
}

/** Patient app: GET /my/nutrition/invites. */
export function listMyInvites(app, patient) {
  return app.inject({ method: 'GET', url: '/my/nutrition/invites', headers: auth(patient.accessToken) });
}

/** Patient app: POST /my/nutrition/invites/:id/accept. */
export function acceptInvite(app, patient, inviteId) {
  return app.inject({ method: 'POST', url: `/my/nutrition/invites/${inviteId}/accept`, headers: auth(patient.accessToken) });
}

/** Patient app: POST /my/nutrition/invites/:id/decline. */
export function declineInvite(app, patient, inviteId) {
  return app.inject({ method: 'POST', url: `/my/nutrition/invites/${inviteId}/decline`, headers: auth(patient.accessToken) });
}

/** Creates a patient user, invites it and accepts through the patient endpoint (consent flow). */
export async function createLinkedPatient(app, nutritionist, { birthDate } = {}) {
  const patient = await createUser(app, 'patient');
  if (birthDate) await prisma.user.update({ where: { id: patient.userId }, data: { birthDate } });
  const invited = await inviteByEmail(app, nutritionist, patient.email);
  expect(invited.statusCode).toBe(201);
  expect(invited.json().outcome).toBe('invited');
  const accepted = await acceptInvite(app, patient, invited.json().invite.id);
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json()).toEqual({ status: 'accepted' });
  return patient;
}

/** Seeds public foods (TACO/TBCA) and returns them by key. Per-100g values mirror the spec examples. */
export async function seedFoods() {
  const meats = await prisma.foodGroup.create({ data: { name: 'Carnes', code: 'carnes' } });
  const cereals = await prisma.foodGroup.create({ data: { name: 'Cereais', code: 'cereais' } });
  const legumes = await prisma.foodGroup.create({ data: { name: 'Leguminosas', code: 'leguminosas' } });
  const make = (group, source, name, kcal, protein, carbs, fat, fiber, serving) =>
    prisma.food.create({
      data: {
        foodGroupId: group.id,
        name,
        source,
        energyKcal: kcal,
        proteinG: protein,
        carbohydratesG: carbs,
        totalFatG: fat,
        fiberG: fiber,
        servingSizeG: serving.grams,
        servingSizeDescription: serving.label,
      },
    });
  const chicken = await make(meats, 'taco', 'Frango, filé, grelhado', 159, 32, 0, 2.5, 0, { grams: 100, label: '1 filé médio' });
  const patinho = await make(meats, 'tbca', 'Patinho, grelhado', 219, 35.9, 0, 7.3, 0, { grams: 100, label: '1 bife' });
  const rice = await make(cereals, 'taco', 'Arroz, integral, cozido', 124, 2.6, 25.8, 1, 2.7, { grams: 125, label: '4 colheres de sopa' });
  const beansTaco = await make(legumes, 'taco', 'Feijão, carioca, cozido', 76, 4.8, 13.6, 0.5, 8.5, { grams: 100, label: '1 concha' });
  const beansTbca = await make(legumes, 'tbca', 'Feijão, preto, cozido', 77, 4.5, 14, 0.5, 8.4, { grams: 100, label: '1 concha' });
  const acai = await make(cereals, 'tbca', 'Açaí, polpa', 58, 0.8, 6.2, 3.9, 2.6, { grams: 100, label: '1 porção' });
  return { groups: { meats, cereals, legumes }, chicken, patinho, rice, beansTaco, beansTbca, acai };
}

/** Per-100g Nutrients matching a seeded food. */
export const CHICKEN_PER_100G = { kcal: 159, protein: 32, carbs: 0, fat: 2.5, fiber: 0 };

/** Gets (creating the draft) the plan of a patient. */
export async function getPlan(app, nutritionist, patientId) {
  const res = await app.inject({
    method: 'GET',
    url: `/nutritionist/patients/${patientId}/plan`,
    headers: auth(nutritionist.accessToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Injects a nutritionist write that must answer 200 with a Plan. */
export async function planWrite(app, nutritionist, method, url, payload) {
  const res = await app.inject({ method, url, headers: auth(nutritionist.accessToken), payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/**
 * Builds a published plan (2 meals: chicken+patinho substitute and a copied option 2; rice).
 */
export async function buildPublishedPlan(app, nutritionist, patientId, foods) {
  let plan = await getPlan(app, nutritionist, patientId);
  const planId = plan.id;
  plan = await planWrite(app, nutritionist, 'PATCH', `/nutritionist/plans/${planId}/goals`, { kcalTarget: 2000, proteinPerKg: 2, fatPerKg: 1, carbIsRemainder: true });
  plan = await planWrite(app, nutritionist, 'PATCH', `/nutritionist/plans/${planId}/guidance`, {
    waterTargetMl: 2000,
    freeMealsPerWeek: 1,
    freeMealText: 'Uma refeição livre por semana',
    patientMessage: 'Bom dia!',
    supplements: [{ name: 'Creatina', dose: '3 g', when: '08:00' }],
  });
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/plans/${planId}/meals`, { name: 'Café', time: '07:00', tip: 'Beba água antes' });
  const meal1 = plan.meals[0];
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/plans/${planId}/meals`, { name: 'Almoço', time: '12:00' });
  const meal2 = plan.meals[1];
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/meal-options/${meal1.options[0].id}/items`, { foodId: foods.chicken.id, quantity: 120, unit: 'g' });
  const chickenItem = plan.meals[0].options[0].items[0];
  plan = await planWrite(app, nutritionist, 'PATCH', `/nutritionist/items/${chickenItem.id}`, { swapBasis: 'protein' });
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/items/${chickenItem.id}/substitutes`, { foodId: foods.patinho.id });
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/meals/${meal1.id}/options`);
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/meal-options/${meal2.options[0].id}/items`, { foodId: foods.rice.id, quantity: 100, unit: 'g' });
  plan = await planWrite(app, nutritionist, 'POST', `/nutritionist/plans/${planId}/publish`);
  return plan;
}

/** GET /my/nutrition/today for a patient. */
export function getToday(app, patient, date) {
  const query = date ? `?date=${date}` : '';
  return app.inject({ method: 'GET', url: `/my/nutrition/today${query}`, headers: auth(patient.accessToken) });
}

/** Asserts the unified error contract and returns the body. */
export function expectErrorContract(res, { statusCode, error, messageCode }) {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json();
  expect(body).toEqual(expect.objectContaining({ error: expect.any(String), messageCode: expect.any(String), message: expect.any(String) }));
  if (error) expect(body.error).toBe(error);
  if (messageCode) expect(body.messageCode).toBe(messageCode);
  return body;
}

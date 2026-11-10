import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createUser,
  createNutritionist,
  createLinkedPatient,
  seedFoods,
  getPlan,
  getToday,
  planWrite,
  buildPublishedPlan,
  saoPauloDate,
  auth,
  expectErrorContract,
} from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// why: writes are limited to [first published day, today + 1], so the days follow the clock instead of fixed dates.
const DAY = saoPauloDate(0);
const OTHER_DAY = saoPauloDate(1);
const WATER_TARGET_ML = 2000;
const CUP_ML = 250;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const MessageCode = Object.freeze({
  SWAP_NOT_ALLOWED: 'nutrition.swap.notAllowed',
  PLAN_NOT_FOUND: 'nutrition.plan.notFound',
});

e2eDescribe('e2e: /my/nutrition (patient app)', () => {
  let app;
  let foods;
  let nutri;
  let patient;
  let published;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    foods = await seedFoods();
    nutri = await createNutritionist(app);
    patient = await createLinkedPatient(app, nutri);
    published = await buildPublishedPlan(app, nutri, patient.userId, foods);
  });

  const mealUrl = (date, mealId) => `/my/nutrition/days/${date}/meals/${mealId}`;
  const swapUrl = (date, itemId) => `/my/nutrition/days/${date}/items/${itemId}/swap`;

  function inject(method, url, payload, user = patient) {
    return app.inject({ method, url, headers: auth(user.accessToken), payload });
  }

  async function today(date = DAY, user = patient) {
    const res = await getToday(app, user, date);
    expect(res.statusCode).toBe(200);
    return res.json().plan;
  }

  const breakfast = () => published.meals[0];
  const lunch = () => published.meals[1];
  const chickenItem = () => breakfast().options[0].items[0];
  const patinhoSubstituteId = () => chickenItem().substitutes[0].id;

  describe('GET /my/nutrition/today', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: `/my/nutrition/today?date=${DAY}` });

      expect(res.statusCode).toBe(401);
    });

    it('should return the plan for a patient whose plan was published without a kcal target', async () => {
      const otherPatient = await createLinkedPatient(app, nutri);
      const draft = await getPlan(app, nutri, otherPatient.userId);
      const url = `/nutritionist/plans/${draft.id}`;
      const withMeal = await planWrite(app, nutri, 'POST', `${url}/meals`, { name: 'Café', time: '07:00' });
      await planWrite(app, nutri, 'POST', `${url}/publish`);

      const res = await getToday(app, otherPatient, DAY);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().plan.id).toBe(withMeal.id);
      expect(res.body).not.toContain('NaN');
    });

    it('should return plan null for a user without a published plan', async () => {
      const other = await createUser(app);

      const res = await getToday(app, other, DAY);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ date: DAY, plan: null });
    });

    it('should return plan null while the plan is still a draft', async () => {
      const secondNutri = await createNutritionist(app);
      const secondPatient = await createLinkedPatient(app, secondNutri);
      await getPlan(app, secondNutri, secondPatient.userId);

      const res = await getToday(app, secondPatient, DAY);

      expect(res.json()).toEqual({ date: DAY, plan: null });
    });

    it('should answer 400 VALIDATION_ERROR for a malformed date', async () => {
      const res = await getToday(app, patient, '02-11-2026');

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should default to today when no date is given', async () => {
      const res = await getToday(app, patient);

      expect(res.json().date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return the plan header: id, version, nutritionist, message, supplements and free meal', async () => {
      const plan = await today();

      expect(plan).toMatchObject({
        id: published.id,
        version: published.version,
        nutritionist: { avatarUrl: null },
        patientMessage: 'Bom dia!',
        supplements: [{ name: 'Creatina', dose: '3 g', when: '08:00' }],
        freeMeal: { perWeek: 1, text: 'Uma refeição livre por semana' },
      });
    });

    it('should return water with target, consumed and cup size', async () => {
      const plan = await today();

      expect(plan.water).toEqual({ targetMl: WATER_TARGET_ML, consumedMl: 0, cupMl: CUP_ML });
    });

    it('should list meals ordered, pending, with option 1 selected, and count them', async () => {
      const plan = await today();

      expect(plan).toMatchObject({ mealsDone: 0, mealsTotal: 2, nextMealId: breakfast().id });
      expect(plan.meals.map((meal) => meal.name)).toEqual(['Café', 'Almoço']);
      expect(plan.meals[0]).toMatchObject({
        status: 'pending',
        doneAt: null,
        note: null,
        tip: 'Beba água antes',
        time: '07:00',
        selectedOptionId: breakfast().options[0].id,
      });
    });

    it('should expose items with canSwap, substitutes and no swap applied', async () => {
      const plan = await today();

      const [withSubstitute] = plan.meals[0].options[0].items;
      const withoutSubstitute = plan.meals[1].options[0].items[0];
      expect(withSubstitute).toMatchObject({ canSwap: true, swappedTo: null, substitutes: [expect.objectContaining({ id: patinhoSubstituteId() })] });
      expect(withoutSubstitute).toMatchObject({ canSwap: false, substitutes: [] });
    });

    it('should not show another nutritionist patient the plan', async () => {
      const stranger = await createUser(app);

      expect(await today(DAY, stranger)).toBeNull();
    });
  });

  describe('PUT/DELETE /my/nutrition/days/:date/meals/:mealId', () => {
    it('should mark a meal done with a doneAt timestamp and advance the next meal', async () => {
      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'done' });

      expect(res.statusCode).toBe(200);
      const plan = res.json().plan;
      expect(plan.meals[0]).toMatchObject({ status: 'done', doneAt: expect.any(String) });
      expect(plan).toMatchObject({ mealsDone: 1, nextMealId: lunch().id });
    });

    it('should register "comi diferente" with a note', async () => {
      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'different', note: 'Comi pizza' });

      expect(res.json().plan.meals[0]).toMatchObject({ status: 'different', note: 'Comi pizza' });
    });

    it('should undo a done meal back to pending', async () => {
      await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'done' });

      const res = await inject('DELETE', mealUrl(DAY, breakfast().id));

      expect(res.statusCode).toBe(200);
      expect(res.json().plan.meals[0]).toMatchObject({ status: 'pending', doneAt: null });
      expect(res.json().plan.mealsDone).toBe(0);
    });

    it('should apply the log only to the given date', async () => {
      await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'done' });

      const plan = await today(OTHER_DAY);

      expect(plan.meals[0].status).toBe('pending');
    });

    it('should not leak the log to another patient of the same nutritionist', async () => {
      const second = await createLinkedPatient(app, nutri);
      await getPlan(app, nutri, second.userId);
      await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'done' });

      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'done' }, second);

      expect(res.statusCode).toBe(404);
    });

    it('should answer 400 for an unknown status', async () => {
      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { status: 'skipped' });

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 404 nutrition.plan.notFound for a meal that is not in the published snapshot', async () => {
      const res = await inject('PUT', mealUrl(DAY, UNKNOWN_ID), { status: 'done' });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.PLAN_NOT_FOUND });
    });

    it('should answer 404 nutrition.plan.notFound for a meal added after publishing (draft only)', async () => {
      const draft = await app.inject({
        method: 'POST',
        url: `/nutritionist/plans/${published.id}/meals`,
        headers: auth(nutri.accessToken),
        payload: { name: 'Ceia', time: '21:00' },
      });
      const draftMealId = draft.json().meals[2].id;

      const res = await inject('PUT', mealUrl(DAY, draftMealId), { status: 'done' });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.PLAN_NOT_FOUND });
    });
  });

  describe('meal option choice', () => {
    it('should default to option 1', async () => {
      const plan = await today();

      expect(plan.meals[0].selectedOptionId).toBe(breakfast().options[0].id);
    });

    it('should select option 2 for the day without changing the status', async () => {
      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { optionId: breakfast().options[1].id });

      expect(res.statusCode).toBe(200);
      expect(res.json().plan.meals[0]).toMatchObject({ selectedOptionId: breakfast().options[1].id, status: 'pending' });
    });

    it('should apply the choice only to that date', async () => {
      await inject('PUT', mealUrl(DAY, breakfast().id), { optionId: breakfast().options[1].id });

      const plan = await today(OTHER_DAY);

      expect(plan.meals[0].selectedOptionId).toBe(breakfast().options[0].id);
    });

    it('should keep the chosen option when the meal status is undone', async () => {
      await inject('PUT', mealUrl(DAY, breakfast().id), { optionId: breakfast().options[1].id, status: 'done' });

      const res = await inject('DELETE', mealUrl(DAY, breakfast().id));

      expect(res.json().plan.meals[0]).toMatchObject({ status: 'pending', selectedOptionId: breakfast().options[1].id });
    });

    it('should answer 404 nutrition.plan.notFound for an option that is not in the meal', async () => {
      const res = await inject('PUT', mealUrl(DAY, breakfast().id), { optionId: UNKNOWN_ID });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.PLAN_NOT_FOUND });
    });
  });

  describe('item swap', () => {
    it('should apply an allowed substitute for the day', async () => {
      const res = await inject('PUT', swapUrl(DAY, chickenItem().id), { substituteId: patinhoSubstituteId() });

      expect(res.statusCode).toBe(200);
      const item = res.json().plan.meals[0].options[0].items[0];
      expect(item.swappedTo).toMatchObject({ substituteId: patinhoSubstituteId(), name: 'Patinho, grelhado', quantity: expect.any(Number) });
    });

    it('should not carry the swap over to another date', async () => {
      await inject('PUT', swapUrl(DAY, chickenItem().id), { substituteId: patinhoSubstituteId() });

      const plan = await today(OTHER_DAY);

      expect(plan.meals[0].options[0].items[0].swappedTo).toBeNull();
    });

    it('should remove the swap with DELETE', async () => {
      await inject('PUT', swapUrl(DAY, chickenItem().id), { substituteId: patinhoSubstituteId() });

      const res = await inject('DELETE', swapUrl(DAY, chickenItem().id));

      expect(res.statusCode).toBe(200);
      expect(res.json().plan.meals[0].options[0].items[0].swappedTo).toBeNull();
    });

    it('should reject a substitute that was not released with 422 nutrition.swap.notAllowed', async () => {
      const res = await inject('PUT', swapUrl(DAY, chickenItem().id), { substituteId: UNKNOWN_ID });

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.SWAP_NOT_ALLOWED });
    });

    it('should reject swapping an item without substitutes with 422 nutrition.swap.notAllowed', async () => {
      const rice = lunch().options[0].items[0];

      const res = await inject('PUT', swapUrl(DAY, rice.id), { substituteId: patinhoSubstituteId() });

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.SWAP_NOT_ALLOWED });
    });

    it('should answer 404 nutrition.plan.notFound for an item that is not in the snapshot', async () => {
      const res = await inject('PUT', swapUrl(DAY, UNKNOWN_ID), { substituteId: patinhoSubstituteId() });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.PLAN_NOT_FOUND });
    });

    it('should not allow a substitute added to the draft after publishing', async () => {
      const added = await app.inject({
        method: 'POST',
        url: `/nutritionist/items/${chickenItem().id}/substitutes`,
        headers: auth(nutri.accessToken),
        payload: { foodId: foods.rice.id },
      });
      const newSubstitute = added.json().meals[0].options[0].items[0].substitutes.find((sub) => sub.foodId === foods.rice.id);

      const res = await inject('PUT', swapUrl(DAY, chickenItem().id), { substituteId: newSubstitute.id });

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.SWAP_NOT_ALLOWED });
    });
  });

  describe('POST /my/nutrition/days/:date/water', () => {
    const water = (ml) => inject('POST', `/my/nutrition/days/${DAY}/water`, { ml });

    it('should add a cup to the day', async () => {
      const res = await water(CUP_ML);

      expect(res.statusCode).toBe(200);
      expect(res.json().plan.water).toEqual({ targetMl: WATER_TARGET_ML, consumedMl: CUP_ML, cupMl: CUP_ML });
    });

    it('should accumulate across calls', async () => {
      await water(CUP_ML);

      const res = await water(CUP_ML);

      expect(res.json().plan.water.consumedMl).toBe(2 * CUP_ML);
    });

    it('should keep the total per date', async () => {
      await water(CUP_ML);

      expect((await today(OTHER_DAY)).water.consumedMl).toBe(0);
    });

    it('should clamp the total at 2x the target', async () => {
      await water(3000);

      const res = await water(3000);

      expect(res.json().plan.water.consumedMl).toBe(2 * WATER_TARGET_ML);
    });

    it('should accept a negative ml to undo', async () => {
      await water(500);

      const res = await water(-CUP_ML);

      expect(res.json().plan.water.consumedMl).toBe(CUP_ML);
    });

    it('should clamp the total at 0', async () => {
      await water(CUP_ML);

      const res = await water(-5000);

      expect(res.json().plan.water.consumedMl).toBe(0);
    });

    it('should answer 400 VALIDATION_ERROR when ml is missing', async () => {
      const res = await inject('POST', `/my/nutrition/days/${DAY}/water`, {});

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: `/my/nutrition/days/${DAY}/water`, payload: { ml: CUP_ML } });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('nutritionist overview reflects the patient logs', () => {
    it('should count done meals, swaps and "comi diferente" in adherence7d', async () => {
      const today = saoPauloDate(0);
      await inject('PUT', mealUrl(today, breakfast().id), { status: 'done' });
      await inject('PUT', mealUrl(today, lunch().id), { status: 'different', note: 'Pizza' });
      await inject('PUT', swapUrl(today, chickenItem().id), { substituteId: patinhoSubstituteId() });

      const res = await app.inject({
        method: 'GET',
        url: `/nutritionist/patients/${patient.userId}/overview`,
        headers: auth(nutri.accessToken),
      });

      expect(res.json().adherence7d).toMatchObject({
        swaps: { total: 1, topPair: { from: 'Frango, filé, grelhado', to: 'Patinho, grelhado' } },
        ateDifferent: { total: 1, topMealName: 'Almoço' },
      });
    });
  });
});

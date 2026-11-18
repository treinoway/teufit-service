import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createUser,
  createNutritionist,
  createLinkedPatient,
  birthDateForAge,
  seedFoods,
  getPlan,
  planWrite,
  getToday,
  buildPublishedPlan,
  auth,
  expectErrorContract,
} from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PlanStatus = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published' });
const MessageCode = Object.freeze({
  NO_MEALS: 'nutrition.plan.noMeals',
  MAX_OPTIONS: 'nutrition.meal.maxOptions',
  FIRST_OPTION_REQUIRED: 'nutrition.meal.firstOptionRequired',
});
const MAX_OPTIONS = 3;
const FREE_MEAL_TEXT_MAX = 500;
const OBSERVATIONS_MAX = 2000;
const PATIENT_MESSAGE_MAX = 500;
const WEIGHT_KG = 66;
const HEIGHT_CM = 165;
const BODY_FAT_PCT = 28;
const MIFFLIN_BMR = 1385.25;
const KATCH_BMR = 1396.43;
const TEE_FACTOR_1375_NO_ACTIVITY = 1904.72;
const TEE_WITH_WEIGHT_TRAINING = 2093.29;
const SUGGESTED_DEFICIT_10 = 1714.25;
const SIGNED_DATE = '2026-11-02';

e2eDescribe('e2e: nutritionist plan', () => {
  let app;
  let foods;
  let nutri;
  let patient;

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
    patient = await createLinkedPatient(app, nutri, { birthDate: birthDateForAge(29) });
  });

  const write = (method, url, payload) => planWrite(app, nutri, method, url, payload);
  const planUrl = (planId, suffix) => `/nutritionist/plans/${planId}/${suffix}`;

  function inject(method, url, payload, token = nutri.accessToken) {
    return app.inject({ method, url, headers: auth(token), payload });
  }

  async function savePatientSheet() {
    const res = await inject('PUT', `/nutritionist/patients/${patient.userId}/sheet`, {
      sex: 'female',
      weightKg: WEIGHT_KG,
      heightCm: HEIGHT_CM,
      bodyFatPct: BODY_FAT_PCT,
      assessedAt: SIGNED_DATE,
    });
    expect(res.statusCode).toBe(200);
  }

  async function planWithMeal() {
    const plan = await getPlan(app, nutri, patient.userId);
    return write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00', tip: 'Beba água' });
  }

  async function planWithChickenItem(quantity = 120) {
    const plan = await planWithMeal();
    return write('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, {
      foodId: foods.chicken.id,
      quantity,
      unit: 'g',
    });
  }

  describe('GET /nutritionist/patients/:patientId/plan', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: `/nutritionist/patients/${patient.userId}/plan` });

      expect(res.statusCode).toBe(401);
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await inject('GET', `/nutritionist/patients/${patient.userId}/plan`, undefined, plain.accessToken);

      expect(res.statusCode).toBe(403);
    });

    it('should not expose a patient linked to another nutritionist', async () => {
      const other = await createNutritionist(app);

      const res = await inject('GET', `/nutritionist/patients/${patient.userId}/plan`, undefined, other.accessToken);

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should create a draft plan on the first call with the full Plan shape', async () => {
      const plan = await getPlan(app, nutri, patient.userId);

      expect(plan).toMatchObject({
        id: expect.any(String),
        patientId: patient.userId,
        status: PlanStatus.DRAFT,
        version: expect.any(Number),
        publishedAt: null,
        hasUnpublishedChanges: false,
        meals: [],
        goals: {
          bmrFormula: expect.any(String),
          activityFactor: expect.any(Number),
          activities: expect.any(Array),
          objective: expect.any(String),
          carbIsRemainder: expect.any(Boolean),
        },
        guidance: { supplements: [], freeMealsPerWeek: expect.any(Number) },
        computed: { dayTotals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } },
      });
    });

    it('should return the same plan on later calls instead of creating another', async () => {
      const first = await getPlan(app, nutri, patient.userId);

      const second = await getPlan(app, nutri, patient.userId);

      expect(second.id).toBe(first.id);
    });
  });

  describe('PATCH /nutritionist/plans/:planId/goals', () => {
    let plan;

    beforeEach(async () => {
      await savePatientSheet();
      plan = await getPlan(app, nutri, patient.userId);
    });

    it('should persist the goals and return them in the Plan', async () => {
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), {
        bmrFormula: 'mifflin',
        activityFactor: 1.375,
        objective: 'deficit_10',
        kcalTarget: 1800,
        proteinPerKg: 2,
        fatPerKg: 1,
        carbPerKg: 3,
        carbIsRemainder: false,
        fiberMinG: 25,
      });

      expect(updated.goals).toMatchObject({
        bmrFormula: 'mifflin',
        activityFactor: 1.375,
        objective: 'deficit_10',
        kcalTarget: 1800,
        proteinPerKg: 2,
        fatPerKg: 1,
        carbPerKg: 3,
        carbIsRemainder: false,
        fiberMinG: 25,
      });
    });

    it('should compute BMR, TEE and the suggested kcal from the patient sheet (Mifflin, factor 1.375, -10%)', async () => {
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), {
        bmrFormula: 'mifflin',
        activityFactor: 1.375,
        activities: [],
        objective: 'deficit_10',
      });

      expect(updated.computed).toMatchObject({
        bmr: MIFFLIN_BMR,
        tee: TEE_FACTOR_1375_NO_ACTIVITY,
        suggestedKcal: SUGGESTED_DEFICIT_10,
      });
    });

    it('should compute the BMR with Katch-McArdle from the lean mass', async () => {
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), { bmrFormula: 'katch_mcardle' });

      expect(updated.computed.bmr).toBe(KATCH_BMR);
    });

    it('should add included activities to the TEE and skip the excluded ones', async () => {
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), {
        bmrFormula: 'mifflin',
        activityFactor: 1.375,
        activities: [
          { name: 'Musculação', met: 5, minutes: 60, perWeek: 4, included: true, fromTraining: true },
          { name: 'Corrida', met: 9, minutes: 60, perWeek: 7, included: false, fromTraining: false },
        ],
      });

      expect(updated.computed.tee).toBe(TEE_WITH_WEIGHT_TRAINING);
    });

    it('should compute macro targets with the carbs closing the calories when carbIsRemainder is true', async () => {
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), {
        kcalTarget: 2000,
        proteinPerKg: 2,
        fatPerKg: 1,
        carbIsRemainder: true,
      });

      expect(updated.computed.macros).toMatchObject({
        protein: { grams: 132, kcal: 528, pct: 26.4 },
        fat: { grams: 66, kcal: 594, pct: 29.7 },
        carbs: { grams: 219.5, kcal: 878, pct: 43.9 },
        totalKcal: 2000,
        diffKcal: 0,
      });
    });

    it.each([
      ['an unknown bmrFormula', { bmrFormula: 'bogus' }],
      ['an activityFactor outside 1.2/1.375/1.55', { activityFactor: 1.4 }],
      ['an unknown objective', { objective: 'bulk' }],
      ['a negative kcalTarget', { kcalTarget: -1 }],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload) => {
      const res = await inject('PATCH', planUrl(plan.id, 'goals'), payload);

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should not let another nutritionist change the plan', async () => {
      const other = await createNutritionist(app);

      const res = await inject('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 1 }, other.accessToken);

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('PATCH /nutritionist/plans/:planId/guidance', () => {
    let plan;

    beforeEach(async () => {
      plan = await getPlan(app, nutri, patient.userId);
    });

    it('should save water, free meals, supplements, observations and patient message', async () => {
      const guidance = {
        waterTargetMl: 2310,
        freeMealsPerWeek: 2,
        freeMealText: 'Aos sábados',
        supplements: [{ name: 'Creatina', dose: '3 g', when: '08:00' }],
        observations: 'Evitar jejum',
        patientMessage: 'Bom dia!',
      };

      const updated = await write('PATCH', planUrl(plan.id, 'guidance'), guidance);

      expect(updated.guidance).toEqual(guidance);
    });

    it.each([
      ['freeMealsPerWeek above 2', { freeMealsPerWeek: 3 }],
      ['freeMealsPerWeek below 0', { freeMealsPerWeek: -1 }],
      [`freeMealText over ${FREE_MEAL_TEXT_MAX} chars`, { freeMealText: 'a'.repeat(FREE_MEAL_TEXT_MAX + 1) }],
      [`observations over ${OBSERVATIONS_MAX} chars`, { observations: 'a'.repeat(OBSERVATIONS_MAX + 1) }],
      [`patientMessage over ${PATIENT_MESSAGE_MAX} chars`, { patientMessage: 'a'.repeat(PATIENT_MESSAGE_MAX + 1) }],
      ['a supplement without a name', { supplements: [{ dose: '3 g', when: '08:00' }] }],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload) => {
      const res = await inject('PATCH', planUrl(plan.id, 'guidance'), payload);

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should accept texts exactly at the limits', async () => {
      const res = await inject('PATCH', planUrl(plan.id, 'guidance'), {
        freeMealText: 'a'.repeat(FREE_MEAL_TEXT_MAX),
        observations: 'a'.repeat(OBSERVATIONS_MAX),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('meals', () => {
    let plan;

    beforeEach(async () => {
      plan = await getPlan(app, nutri, patient.userId);
    });

    it('should create a meal with one empty option at position 1', async () => {
      const updated = await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00', tip: 'Beba água' });

      expect(updated.meals).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          name: 'Café',
          time: '07:00',
          order: expect.any(Number),
          tip: 'Beba água',
          options: [expect.objectContaining({ position: 1, items: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } })],
        }),
      ]);
    });

    it('should default tip to null', async () => {
      const updated = await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });

      expect(updated.meals[0].tip).toBeNull();
    });

    it.each([
      ['an invalid time', { name: 'Café', time: '25:61' }],
      ['a missing name', { time: '07:00' }],
      ['a missing time', { name: 'Café' }],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload) => {
      const res = await inject('POST', planUrl(plan.id, 'meals'), payload);

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should edit name, time and tip of a meal', async () => {
      const created = await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });

      const updated = await write('PATCH', `/nutritionist/meals/${created.meals[0].id}`, { name: 'Desjejum', time: '06:30', tip: 'Sem açúcar' });

      expect(updated.meals[0]).toMatchObject({ name: 'Desjejum', time: '06:30', tip: 'Sem açúcar' });
    });

    it('should reorder meals with PUT .../meals/order', async () => {
      await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });
      const two = await write('POST', planUrl(plan.id, 'meals'), { name: 'Almoço', time: '12:00' });
      const [first, second] = two.meals;

      const updated = await write('PUT', planUrl(plan.id, 'meals/order'), { mealIds: [second.id, first.id] });

      expect(updated.meals.map((meal) => meal.id)).toEqual([second.id, first.id]);
    });

    it('should remove a meal', async () => {
      const created = await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });

      const updated = await write('DELETE', `/nutritionist/meals/${created.meals[0].id}`);

      expect(updated.meals).toEqual([]);
    });

    it('should not let another nutritionist edit the meal', async () => {
      const created = await write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });
      const other = await createNutritionist(app);

      const res = await inject('PATCH', `/nutritionist/meals/${created.meals[0].id}`, { name: 'x' }, other.accessToken);

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('meal options', () => {
    it('should copy the items of option 1 into the new option as position 2', async () => {
      const plan = await planWithChickenItem();

      const updated = await write('POST', `/nutritionist/meals/${plan.meals[0].id}/options`);

      const [option1, option2] = updated.meals[0].options;
      expect(option2.position).toBe(2);
      expect(option2.items).toHaveLength(1);
      expect(option2.items[0]).toMatchObject({ foodId: foods.chicken.id, quantity: 120, name: option1.items[0].name });
      expect(option2.items[0].id).not.toBe(option1.items[0].id);
    });

    it('should reject a 4th option with 422 nutrition.meal.maxOptions', async () => {
      const plan = await planWithMeal();
      const mealId = plan.meals[0].id;
      for (let index = 1; index < MAX_OPTIONS; index += 1) {
        await write('POST', `/nutritionist/meals/${mealId}/options`);
      }

      const res = await inject('POST', `/nutritionist/meals/${mealId}/options`);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.MAX_OPTIONS });
    });

    it('should delete option 2', async () => {
      const plan = await planWithMeal();
      const withTwo = await write('POST', `/nutritionist/meals/${plan.meals[0].id}/options`);

      const updated = await write('DELETE', `/nutritionist/meal-options/${withTwo.meals[0].options[1].id}`);

      expect(updated.meals[0].options).toHaveLength(1);
    });

    it('should reject deleting option 1 with 422 nutrition.meal.firstOptionRequired', async () => {
      const plan = await planWithMeal();

      const res = await inject('DELETE', `/nutritionist/meal-options/${plan.meals[0].options[0].id}`);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.FIRST_OPTION_REQUIRED });
    });
  });

  describe('items', () => {
    it('should add a food with its default portion when quantity is omitted', async () => {
      const plan = await planWithMeal();

      const updated = await write('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, { foodId: foods.rice.id });

      expect(updated.meals[0].options[0].items[0]).toMatchObject({
        foodId: foods.rice.id,
        name: 'Arroz, integral, cozido',
        source: 'taco',
        householdMeasure: '4 colheres de sopa',
        quantity: 125,
        unit: 'g',
        per100g: { kcal: 124, protein: 2.6, carbs: 25.8, fat: 1, fiber: 2.7 },
        substitutes: [],
      });
    });

    it('should compute the item nutrients from per100g x quantity / 100', async () => {
      const updated = await planWithChickenItem(120);

      expect(updated.meals[0].options[0].items[0].nutrients).toEqual({ kcal: 190.8, protein: 38.4, carbs: 0, fat: 3, fiber: 0 });
    });

    it('should recompute option totals and the day totals when the quantity changes', async () => {
      const plan = await planWithChickenItem(120);
      const itemId = plan.meals[0].options[0].items[0].id;

      const updated = await write('PATCH', `/nutritionist/items/${itemId}`, { quantity: 200 });

      expect(updated.meals[0].options[0].totals).toEqual({ kcal: 318, protein: 64, carbs: 0, fat: 5, fiber: 0 });
      expect(updated.computed.dayTotals).toEqual({ kcal: 318, protein: 64, carbs: 0, fat: 5, fiber: 0 });
    });

    it('should count only option 1 in the day totals', async () => {
      const plan = await planWithChickenItem(100);
      const withTwo = await write('POST', `/nutritionist/meals/${plan.meals[0].id}/options`);
      await write('PATCH', `/nutritionist/items/${withTwo.meals[0].options[1].items[0].id}`, { quantity: 500 });

      const updated = await getPlan(app, nutri, patient.userId);

      expect(updated.computed.dayTotals.kcal).toBe(159);
    });

    it('should report the day status against the goals (kcal on target)', async () => {
      const plan = await planWithChickenItem(100);
      await write('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 159 });

      const updated = await getPlan(app, nutri, patient.userId);

      expect(updated.computed.dayStatus.kcal).toBe('ok');
    });

    it('should remove an item', async () => {
      const plan = await planWithChickenItem();

      const updated = await write('DELETE', `/nutritionist/items/${plan.meals[0].options[0].items[0].id}`);

      expect(updated.meals[0].options[0].items).toEqual([]);
    });

    it('should answer 404 for a food that does not exist', async () => {
      const plan = await planWithMeal();

      const res = await inject('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, {
        foodId: '00000000-0000-4000-8000-000000000000',
      });

      expect(res.statusCode).toBe(404);
    });

    it('should accept a custom food of the nutritionist and tag the item source custom', async () => {
      const plan = await planWithMeal();
      const custom = (
        await inject('POST', '/nutritionist/foods', {
          name: 'Bolo da Ana',
          groupId: foods.groups.cereals.id,
          portion: { label: '1 fatia', grams: 60 },
          per100g: { kcal: 350, protein: 6, carbs: 55, fat: 12, fiber: 1.5 },
        })
      ).json();

      const updated = await write('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, { foodId: custom.id });

      expect(updated.meals[0].options[0].items[0]).toMatchObject({ source: 'custom', quantity: 60, householdMeasure: '1 fatia' });
    });

    it("should reject another nutritionist's custom food", async () => {
      const plan = await planWithMeal();
      const other = await createNutritionist(app);
      const custom = (
        await inject(
          'POST',
          '/nutritionist/foods',
          {
            name: 'Bolo privado',
            groupId: foods.groups.cereals.id,
            portion: { label: '1 fatia', grams: 60 },
            per100g: { kcal: 350, protein: 6, carbs: 55, fat: 12, fiber: 1.5 },
          },
          other.accessToken,
        )
      ).json();

      const res = await inject('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, { foodId: custom.id });

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('substitutes', () => {
    const PATINHO_BY_PROTEIN_G = 106.96;
    const PATINHO_BY_KCAL_G = 87.12;

    async function chickenWithProteinBasis() {
      const plan = await planWithChickenItem(120);
      const itemId = plan.meals[0].options[0].items[0].id;
      await write('PATCH', `/nutritionist/items/${itemId}`, { swapBasis: 'protein' });
      return itemId;
    }

    it('should add a substitute with the quantity equalizing protein', async () => {
      const itemId = await chickenWithProteinBasis();

      const updated = await write('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.patinho.id });

      const [substitute] = updated.meals[0].options[0].items[0].substitutes;
      expect(substitute).toMatchObject({ foodId: foods.patinho.id, name: 'Patinho, grelhado', source: 'taco' });
      expect(substitute.quantity).toBeCloseTo(PATINHO_BY_PROTEIN_G, 2);
      expect(substitute.nutrients.protein).toBeCloseTo(38.4, 1);
    });

    it('should recompute every substitute quantity when swapBasis changes to kcal', async () => {
      const itemId = await chickenWithProteinBasis();
      await write('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.patinho.id });

      const updated = await write('PATCH', `/nutritionist/items/${itemId}`, { swapBasis: 'kcal' });

      const item = updated.meals[0].options[0].items[0];
      expect(item.swapBasis).toBe('kcal');
      expect(item.substitutes[0].quantity).toBeCloseTo(PATINHO_BY_KCAL_G, 2);
    });

    it('should remove a substitute', async () => {
      const itemId = await chickenWithProteinBasis();
      const withSub = await write('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.patinho.id });

      const updated = await write('DELETE', `/nutritionist/substitutes/${withSub.meals[0].options[0].items[0].substitutes[0].id}`);

      expect(updated.meals[0].options[0].items[0].substitutes).toEqual([]);
    });

    it('should not let another nutritionist add a substitute', async () => {
      const itemId = await chickenWithProteinBasis();
      const other = await createNutritionist(app);

      const res = await inject('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.patinho.id }, other.accessToken);

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('POST /nutritionist/plans/:planId/publish', () => {
    it('should reject a plan without meals with 422 nutrition.plan.noMeals', async () => {
      const plan = await getPlan(app, nutri, patient.userId);
      await write('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 2000 });

      const res = await inject('POST', planUrl(plan.id, 'publish'));

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.NO_MEALS });
    });

    it('should publish a plan with meals but no kcal target', async () => {
      const plan = await planWithMeal();

      const res = await inject('POST', planUrl(plan.id, 'publish'));

      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.status).toBe(PlanStatus.PUBLISHED);
      expect(body.goals.kcalTarget).toBeNull();
      expect(body.computed.dayStatus.kcal).toBeNull();
      expect(res.body).not.toContain('NaN');
    });

    it('should keep the nutritionist plan and patients list working after publishing without a kcal target', async () => {
      const plan = await planWithMeal();
      await write('POST', planUrl(plan.id, 'publish'));

      const planRes = await inject('GET', `/nutritionist/patients/${patient.userId}/plan`);
      const listRes = await inject('GET', '/nutritionist/patients');

      expect(planRes.statusCode, planRes.body).toBe(200);
      expect(listRes.statusCode, listRes.body).toBe(200);
      expect(listRes.json().items).toHaveLength(1);
    });

    it('should publish: status published, publishedAt set, version incremented, no unpublished changes', async () => {
      const plan = await planWithMeal();
      const updated = await write('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 2000 });

      const published = await write('POST', planUrl(plan.id, 'publish'));

      expect(published).toMatchObject({
        id: plan.id,
        status: PlanStatus.PUBLISHED,
        publishedAt: expect.any(String),
        version: updated.version + 1,
        hasUnpublishedChanges: false,
      });
    });

    it('should not let another nutritionist publish the plan', async () => {
      const plan = await planWithMeal();
      await write('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 2000 });
      const other = await createNutritionist(app);

      const res = await inject('POST', planUrl(plan.id, 'publish'), undefined, other.accessToken);

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should keep one plan per patient: GET after publishing returns the same plan', async () => {
      const published = await buildPublishedPlan(app, nutri, patient.userId, foods);

      const again = await getPlan(app, nutri, patient.userId);

      expect(again.id).toBe(published.id);
      expect(again.status).toBe(PlanStatus.PUBLISHED);
    });
  });

  describe('published plan edits (snapshot isolation)', () => {
    let published;
    let todayBefore;

    beforeEach(async () => {
      published = await buildPublishedPlan(app, nutri, patient.userId, foods);
      todayBefore = (await getToday(app, patient, SIGNED_DATE)).json();
    });

    it('should flag hasUnpublishedChanges and keep status published after an edit', async () => {
      const updated = await write('PATCH', `/nutritionist/items/${published.meals[0].options[0].items[0].id}`, { quantity: 300 });

      expect(updated).toMatchObject({ status: PlanStatus.PUBLISHED, hasUnpublishedChanges: true });
    });

    it('should flag hasUnpublishedChanges after a goals change', async () => {
      const updated = await write('PATCH', planUrl(published.id, 'goals'), { kcalTarget: 2500 });

      expect(updated.hasUnpublishedChanges).toBe(true);
    });

    it('should flag hasUnpublishedChanges after adding a meal', async () => {
      const updated = await write('POST', planUrl(published.id, 'meals'), { name: 'Ceia', time: '21:00' });

      expect(updated.hasUnpublishedChanges).toBe(true);
    });

    it('should keep showing the patient the previous snapshot until republishing', async () => {
      await write('PATCH', `/nutritionist/items/${published.meals[0].options[0].items[0].id}`, { quantity: 300 });
      await write('POST', planUrl(published.id, 'meals'), { name: 'Ceia', time: '21:00' });

      const todayAfter = (await getToday(app, patient, SIGNED_DATE)).json();

      expect(todayAfter).toEqual(todayBefore);
    });

    it('should show the new content after republishing and clear the flag', async () => {
      await write('POST', planUrl(published.id, 'meals'), { name: 'Ceia', time: '21:00' });

      const republished = await write('POST', planUrl(published.id, 'publish'));

      const todayAfter = (await getToday(app, patient, SIGNED_DATE)).json();
      expect(republished).toMatchObject({ hasUnpublishedChanges: false, version: published.version + 1 });
      expect(todayAfter.plan.mealsTotal).toBe(todayBefore.plan.mealsTotal + 1);
      expect(todayAfter.plan.version).toBe(republished.version);
    });

    it('should report the plan summary on GET /nutritionist/patients with hasUnpublishedChanges', async () => {
      await write('POST', planUrl(published.id, 'meals'), { name: 'Ceia', time: '21:00' });

      const res = await inject('GET', '/nutritionist/patients');

      expect(res.json().items[0].plan).toEqual({
        id: published.id,
        status: PlanStatus.PUBLISHED,
        publishedAt: expect.any(String),
        hasUnpublishedChanges: true,
      });
    });
  });
});

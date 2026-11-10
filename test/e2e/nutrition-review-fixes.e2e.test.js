import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  createNutritionist,
  createLinkedPatient,
  inviteByEmail,
  listMyInvites,
  acceptInvite,
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

const MessageCode = Object.freeze({
  DAY_OUT_OF_RANGE: 'nutrition.day.outOfRange',
  CANNOT_EQUATE: 'nutrition.substitute.cannotEquate',
  QUANTITY_TOO_LARGE: 'nutrition.substitute.quantityTooLarge',
  MAX_OPTIONS: 'nutrition.meal.maxOptions',
});
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const CUP_ML = 250;
const CONCURRENT_WATER_ADDS = 8;
const PUBLISH_RACE_ROUNDS = 12;
const PUBLISH_RACE_STAGGER_MS = 3;
const DOUBLE_PUBLISH_ROUNDS = 5;
const MAX_OPTIONS = 3;
const CONCURRENT_OPTION_ADDS = 5;
const MAX_ITEM_QUANTITY = 100000;
const TINY_PROTEIN_PER_100G = 0.01;
const FAR_FUTURE_OFFSET_DAYS = 3;

e2eDescribe('e2e: nutrition review fixes', () => {
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
    patient = await createLinkedPatient(app, nutri);
  });

  function inject(method, url, payload, token = nutri.accessToken) {
    return app.inject({ method, url, headers: auth(token), payload });
  }

  const write = (method, url, payload) => planWrite(app, nutri, method, url, payload);
  const planUrl = (planId, suffix) => `/nutritionist/plans/${planId}/${suffix}`;

  function patientInject(method, url, payload) {
    return app.inject({ method, url, headers: auth(patient.accessToken), payload });
  }

  async function publishedPlan() {
    return buildPublishedPlan(app, nutri, patient.userId, foods);
  }

  async function seedFood(name, per100g) {
    return prisma.food.create({
      data: {
        foodGroupId: foods.groups.meats.id,
        name,
        source: 'taco',
        energyKcal: per100g.kcal,
        proteinG: per100g.protein,
        carbohydratesG: 0,
        totalFatG: per100g.fat ?? 0,
        fiberG: 0,
        servingSizeG: 100,
        servingSizeDescription: '1 porção',
      },
    });
  }

  async function planWithMeal() {
    const plan = await getPlan(app, nutri, patient.userId);
    return write('POST', planUrl(plan.id, 'meals'), { name: 'Café', time: '07:00' });
  }

  async function planWithItem(food, quantity) {
    const plan = await planWithMeal();
    return write('POST', `/nutritionist/meal-options/${plan.meals[0].options[0].id}/items`, { foodId: food.id, quantity, unit: 'g' });
  }

  describe('S1: publish concurrency', () => {
    it('should reflect a concurrent guidance edit in the snapshot or keep it flagged as unpublished (or answer 409)', async () => {
      const plan = await publishedPlan();

      for (let round = 0; round < PUBLISH_RACE_ROUNDS; round += 1) {
        const message = `Recado ${round}`;
        const [publish, patch] = await Promise.all([
          inject('POST', planUrl(plan.id, 'publish')),
          new Promise((resolve) => setTimeout(resolve, round * PUBLISH_RACE_STAGGER_MS)).then(() =>
            inject('PATCH', planUrl(plan.id, 'guidance'), { patientMessage: message })),
        ]);
        expect([HTTP_OK, HTTP_CONFLICT]).toContain(publish.statusCode);
        expect([HTTP_OK, HTTP_CONFLICT]).toContain(patch.statusCode);
        if (publish.statusCode !== HTTP_OK || patch.statusCode !== HTTP_OK) continue;

        const draft = await getPlan(app, nutri, patient.userId);
        const snapshotMessage = (await getToday(app, patient, saoPauloDate(0))).json().plan.patientMessage;
        const reflected = snapshotMessage === draft.guidance.patientMessage;
        expect(reflected || draft.hasUnpublishedChanges, `round ${round}: lost update`).toBe(true);
      }
    });

    it('should never hand out the same version to two concurrent publishes', async () => {
      const plan = await publishedPlan();
      let expectedVersion = plan.version;

      for (let round = 0; round < DOUBLE_PUBLISH_ROUNDS; round += 1) {
        const responses = await Promise.all([
          inject('POST', planUrl(plan.id, 'publish')),
          inject('POST', planUrl(plan.id, 'publish')),
        ]);
        responses.forEach((res) => expect([HTTP_OK, HTTP_CONFLICT]).toContain(res.statusCode));
        const versions = responses.filter((res) => res.statusCode === HTTP_OK).map((res) => res.json().version);
        expect(new Set(versions).size, `round ${round}: duplicated version ${versions}`).toBe(versions.length);
        expectedVersion += versions.length;
        expect((await getPlan(app, nutri, patient.userId)).version).toBe(expectedVersion);
      }
    });
  });

  describe('S2: goals', () => {
    it('should answer 400 for kcalTarget 0 and for waterTargetMl 0 (not meaningful goals)', async () => {
      const plan = await getPlan(app, nutri, patient.userId);

      const kcal = await inject('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 0 });
      const water = await inject('PATCH', planUrl(plan.id, 'guidance'), { waterTargetMl: 0 });

      expectErrorContract(kcal, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expectErrorContract(water, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should still accept null to clear the kcal target and the water target', async () => {
      const plan = await getPlan(app, nutri, patient.userId);
      await write('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: 2000 });

      const goals = await inject('PATCH', planUrl(plan.id, 'goals'), { kcalTarget: null });
      const guidance = await inject('PATCH', planUrl(plan.id, 'guidance'), { waterTargetMl: null });

      expect(goals.statusCode).toBe(HTTP_OK);
      expect(guidance.statusCode).toBe(HTTP_OK);
    });

    it('should report no status for macros whose goal is unset even with a kcal target and items', async () => {
      const withItem = await planWithItem(foods.chicken, 120);
      await write('PATCH', planUrl(withItem.id, 'goals'), { kcalTarget: 2000, proteinPerKg: 2 });
      await write('PATCH', planUrl(withItem.id, 'goals'), { fatPerKg: null, carbPerKg: null, carbIsRemainder: false, fiberMinG: null });
      await inject('PUT', `/nutritionist/patients/${patient.userId}/sheet`, { sex: 'female', weightKg: 66, heightCm: 165 });

      const { computed } = await getPlan(app, nutri, patient.userId);

      expect(computed.dayStatus).toMatchObject({ fat: null, carbs: null, fiber: null });
      expect(computed.dayStatus.kcal).not.toBeNull();
      expect(computed.dayStatus.protein).not.toBeNull();
    });
  });

  describe('S3: water', () => {
    it('should count every one of the concurrent cup adds', async () => {
      await publishedPlan();
      const day = saoPauloDate(0);

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_WATER_ADDS }, () =>
          patientInject('POST', `/my/nutrition/days/${day}/water`, { ml: CUP_ML })),
      );

      responses.forEach((res) => expect(res.statusCode).toBe(HTTP_OK));
      const consumed = (await getToday(app, patient, day)).json().plan.water.consumedMl;
      expect(consumed).toBe(CONCURRENT_WATER_ADDS * CUP_ML);
    });
  });

  describe('S4: writable day window [first published day, today + 1]', () => {
    let published;

    beforeEach(async () => {
      published = await publishedPlan();
    });

    const mealId = () => published.meals[0].id;
    const chickenItem = () => published.meals[0].options[0].items[0];
    const substituteId = () => chickenItem().substitutes[0].id;
    const writes = [
      ['meal status', (day) => ['PUT', `/my/nutrition/days/${day}/meals/${mealId()}`, { status: 'done' }]],
      ['meal option', (day) => ['PUT', `/my/nutrition/days/${day}/meals/${mealId()}`, { optionId: published.meals[0].options[1].id }]],
      ['item swap', (day) => ['PUT', `/my/nutrition/days/${day}/items/${chickenItem().id}/swap`, { substituteId: substituteId() }]],
      ['water', (day) => ['POST', `/my/nutrition/days/${day}/water`, { ml: CUP_ML }]],
    ];

    it.each(writes)('should accept the %s write for today and for tomorrow', async (_label, build) => {
      const today = await patientInject(...build(saoPauloDate(0)));
      const tomorrow = await patientInject(...build(saoPauloDate(1)));

      expect(today.statusCode).toBe(HTTP_OK);
      expect(tomorrow.statusCode).toBe(HTTP_OK);
    });

    it.each(writes)('should reject the %s write two days ahead with 422 nutrition.day.outOfRange', async (_label, build) => {
      const res = await patientInject(...build(saoPauloDate(2)));

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.DAY_OUT_OF_RANGE });
    });

    it.each(writes)('should reject the %s write for a day before the first publication with 422 nutrition.day.outOfRange', async (_label, build) => {
      const res = await patientInject(...build(saoPauloDate(-1)));

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.DAY_OUT_OF_RANGE });
    });

    it('should persist nothing when a write is rejected as out of range', async () => {
      await patientInject('PUT', `/my/nutrition/days/${saoPauloDate(FAR_FUTURE_OFFSET_DAYS)}/meals/${mealId()}`, { status: 'done' });
      await patientInject('POST', `/my/nutrition/days/${saoPauloDate(-1)}/water`, { ml: CUP_ML });

      expect(await prisma.dietMealLog.count({ where: { patientId: patient.userId } })).toBe(0);
      expect(await prisma.waterLog.count({ where: { patientId: patient.userId } })).toBe(0);
    });

    it('should still let the app read any day', async () => {
      const far = await getToday(app, patient, saoPauloDate(FAR_FUTURE_OFFSET_DAYS));
      const past = await getToday(app, patient, saoPauloDate(-1));

      expect(far.statusCode).toBe(HTTP_OK);
      expect(past.statusCode).toBe(HTTP_OK);
    });

    it('should ignore logs outside the window in the 7 day adherence (inflated writes seeded directly)', async () => {
      const mealLogBase = { patientId: patient.userId, planId: published.id, mealId: mealId(), status: 'done', doneAt: new Date() };
      await patientInject('PUT', `/my/nutrition/days/${saoPauloDate(0)}/meals/${mealId()}`, { status: 'done' });
      await prisma.dietMealLog.create({ data: { ...mealLogBase, date: new Date(`${saoPauloDate(FAR_FUTURE_OFFSET_DAYS)}T00:00:00.000Z`) } });
      await prisma.dietMealLog.create({ data: { ...mealLogBase, date: new Date(`${saoPauloDate(-1)}T00:00:00.000Z`) } });
      await prisma.dietSwapLog.create({
        data: {
          patientId: patient.userId,
          planId: published.id,
          itemId: chickenItem().id,
          substituteId: substituteId(),
          date: new Date(`${saoPauloDate(FAR_FUTURE_OFFSET_DAYS)}T00:00:00.000Z`),
        },
      });

      const res = await inject('GET', `/nutritionist/patients/${patient.userId}/overview`);

      expect(res.json().adherence7d).toMatchObject({ mealsDone: 1, swaps: { total: 0 } });
    });
  });

  describe('S5: writes after the patient was unlinked', () => {
    async function dumpPlanTree() {
      return JSON.stringify(
        await prisma.dietProtocol.findMany({
          include: { meals: { include: { options: { include: { items: { include: { substitutes: true } } } } } } },
          orderBy: { id: 'asc' },
        }),
      );
    }

    let published;
    let before;

    beforeEach(async () => {
      published = await publishedPlan();
      await inject('DELETE', `/nutritionist/patients/${patient.userId}`);
      before = await dumpPlanTree();
    });

    const meal = () => published.meals[0];
    const item = () => meal().options[0].items[0];
    const attempts = [
      ['PATCH goals', () => ['PATCH', planUrl(published.id, 'goals'), { kcalTarget: 3000 }]],
      ['PATCH guidance', () => ['PATCH', planUrl(published.id, 'guidance'), { patientMessage: 'Ainda aqui?' }]],
      ['POST meal', () => ['POST', planUrl(published.id, 'meals'), { name: 'Ceia', time: '21:00' }]],
      ['PATCH meal', () => ['PATCH', `/nutritionist/meals/${meal().id}`, { name: 'Renomeado' }]],
      ['DELETE meal', () => ['DELETE', `/nutritionist/meals/${meal().id}`]],
      ['POST option', () => ['POST', `/nutritionist/meals/${meal().id}/options`]],
      ['POST item', () => ['POST', `/nutritionist/meal-options/${meal().options[0].id}/items`, { foodId: foods.rice.id }]],
      ['PATCH item', () => ['PATCH', `/nutritionist/items/${item().id}`, { quantity: 999 }]],
      ['DELETE item', () => ['DELETE', `/nutritionist/items/${item().id}`]],
      ['POST substitute', () => ['POST', `/nutritionist/items/${item().id}/substitutes`, { foodId: foods.rice.id }]],
      ['DELETE substitute', () => ['DELETE', `/nutritionist/substitutes/${item().substitutes[0].id}`]],
      ['POST publish', () => ['POST', planUrl(published.id, 'publish')]],
    ];

    it.each(attempts)('should answer 404 and persist nothing on %s', async (_label, build) => {
      const res = await inject(...build());

      expect(res.statusCode).toBe(404);
      expect(await dumpPlanTree()).toBe(before);
    });
  });

  describe('S6: substitute needs the basis nutrient on the original item', () => {
    it('should reject with 422 nutrition.substitute.cannotEquate a substitute for an item with 0 g of protein (protein basis)', async () => {
      const oil = await seedFood('Azeite de oliva', { kcal: 884, protein: 0, fat: 100 });
      const plan = await planWithItem(oil, 10);

      const res = await inject('POST', `/nutritionist/items/${plan.meals[0].options[0].items[0].id}/substitutes`, { foodId: foods.chicken.id });

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.CANNOT_EQUATE });
    });

    it('should not store a 0 g substitute when it is rejected', async () => {
      const oil = await seedFood('Azeite de oliva', { kcal: 884, protein: 0, fat: 100 });
      const plan = await planWithItem(oil, 10);

      await inject('POST', `/nutritionist/items/${plan.meals[0].options[0].items[0].id}/substitutes`, { foodId: foods.chicken.id });

      expect(await prisma.dietItemSubstitute.count()).toBe(0);
    });

    it('should accept the same substitute on the calories basis (the oil has kcal)', async () => {
      const oil = await seedFood('Azeite de oliva', { kcal: 884, protein: 0, fat: 100 });
      const plan = await planWithItem(oil, 10);
      const itemId = plan.meals[0].options[0].items[0].id;
      await write('PATCH', `/nutritionist/items/${itemId}`, { swapBasis: 'kcal' });

      const res = await inject('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.chicken.id });

      expect(res.statusCode).toBe(HTTP_OK);
    });

    it('should reject switching the item to a basis its zero nutrient cannot equate, leaving it unchanged', async () => {
      const oil = await seedFood('Azeite de oliva', { kcal: 884, protein: 0, fat: 100 });
      const plan = await planWithItem(oil, 10);
      const itemId = plan.meals[0].options[0].items[0].id;
      await write('PATCH', `/nutritionist/items/${itemId}`, { swapBasis: 'kcal' });
      await write('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: foods.chicken.id });

      const res = await inject('PATCH', `/nutritionist/items/${itemId}`, { swapBasis: 'protein' });

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.CANNOT_EQUATE });
      expect((await prisma.dietFoodItem.findUnique({ where: { id: itemId } })).swapBasis).toBe('kcal');
    });
  });

  describe('S7: equivalent quantity above the column maximum', () => {
    it('should reject with 422 nutrition.substitute.quantityTooLarge instead of a 500', async () => {
      const tiny = await seedFood('Alimento quase sem proteína', { kcal: 5, protein: TINY_PROTEIN_PER_100G });
      const plan = await planWithItem(foods.chicken, MAX_ITEM_QUANTITY);

      const res = await inject('POST', `/nutritionist/items/${plan.meals[0].options[0].items[0].id}/substitutes`, { foodId: tiny.id });

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.QUANTITY_TOO_LARGE });
    });

    it('should reject with 422 when raising an item quantity makes an existing substitute overflow, leaving the item unchanged', async () => {
      const tiny = await seedFood('Alimento quase sem proteína', { kcal: 5, protein: TINY_PROTEIN_PER_100G });
      const plan = await planWithItem(foods.chicken, 100);
      const itemId = plan.meals[0].options[0].items[0].id;
      await write('POST', `/nutritionist/items/${itemId}/substitutes`, { foodId: tiny.id });

      const res = await inject('PATCH', `/nutritionist/items/${itemId}`, { quantity: MAX_ITEM_QUANTITY });

      expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.QUANTITY_TOO_LARGE });
      expect(Number((await prisma.dietFoodItem.findUnique({ where: { id: itemId } })).quantity)).toBe(100);
    });
  });

  describe('S9: concurrent addOption', () => {
    it('should never answer 500: losers get 422 nutrition.meal.maxOptions and positions stay unique within the cap', async () => {
      const plan = await planWithMeal();
      const mealId = plan.meals[0].id;

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_OPTION_ADDS }, () => inject('POST', `/nutritionist/meals/${mealId}/options`)),
      );

      responses.forEach((res) => expect([HTTP_OK, HTTP_UNPROCESSABLE]).toContain(res.statusCode));
      responses
        .filter((res) => res.statusCode === HTTP_UNPROCESSABLE)
        .forEach((res) => expectErrorContract(res, { statusCode: HTTP_UNPROCESSABLE, messageCode: MessageCode.MAX_OPTIONS }));
      const options = await prisma.dietMealOption.findMany({ where: { mealId }, orderBy: { position: 'asc' } });
      expect(options.map((option) => option.position)).toEqual(Array.from({ length: MAX_OPTIONS }, (_, index) => index + 1));
      expect(responses.filter((res) => res.statusCode === HTTP_OK)).toHaveLength(MAX_OPTIONS - 1);
    });
  });

  describe('nits', () => {
    it('should return supplements without dose and when as dose null and when null', async () => {
      const plan = await getPlan(app, nutri, patient.userId);

      const updated = await write('PATCH', planUrl(plan.id, 'guidance'), { supplements: [{ name: 'Whey' }] });

      expect(updated.guidance.supplements).toEqual([{ name: 'Whey', dose: null, when: null }]);
      expect((await getPlan(app, nutri, patient.userId)).guidance.supplements).toEqual([{ name: 'Whey', dose: null, when: null }]);
    });

    it('should carry the null dose and when into what the app sees after publishing', async () => {
      const published = await publishedPlan();
      await write('PATCH', planUrl(published.id, 'guidance'), { supplements: [{ name: 'Whey' }] });
      await write('POST', planUrl(published.id, 'publish'));

      const today = (await getToday(app, patient, saoPauloDate(0))).json().plan;

      expect(today.supplements).toEqual([{ name: 'Whey', dose: null, when: null }]);
    });

    it('should report linkedAt of the latest link after unlinking and linking again', async () => {
      const firstLinkedAt = (await inject('GET', '/nutritionist/patients')).json().items[0].linkedAt;
      await inject('DELETE', `/nutritionist/patients/${patient.userId}`);
      const reinvited = await inviteByEmail(app, nutri, patient.email);
      await acceptInvite(app, patient, reinvited.json().invite.id);

      const [row] = (await inject('GET', '/nutritionist/patients')).json().items;

      expect(new Date(row.linkedAt).getTime()).toBeGreaterThan(new Date(firstLinkedAt).getTime());
      expect(await listMyInvites(app, patient).then((res) => res.json().items)).toEqual([]);
    });
  });
});

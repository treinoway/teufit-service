import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createUser, createNutritionist, seedFoods, auth, expectErrorContract } from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const Source = Object.freeze({ TACO: 'taco', TBCA: 'tbca', CUSTOM: 'custom' });
const ALL_SOURCES = `${Source.TACO},${Source.TBCA},${Source.CUSTOM}`;
const CUSTOM_PER_100G = { kcal: 350, protein: 6, carbs: 55, fat: 12, fiber: 1.5 };
const MAX_MACRO_PER_100G = 100;
const MAX_KCAL_PER_100G = 1000;
const PER_100G_OVER_LIMIT = [
  ['protein', MAX_MACRO_PER_100G + 0.01],
  ['carbs', MAX_MACRO_PER_100G + 0.01],
  ['fat', MAX_MACRO_PER_100G + 0.01],
  ['fiber', MAX_MACRO_PER_100G + 0.01],
  ['kcal', MAX_KCAL_PER_100G + 0.01],
];

e2eDescribe('e2e: foods search and custom foods', () => {
  let app;
  let foods;
  let nutri;

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
  });

  async function search(token, query) {
    const res = await app.inject({ method: 'GET', url: `/foods?${query}`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return res.json().items;
  }

  function createCustom(token, overrides = {}) {
    return app.inject({
      method: 'POST',
      url: '/nutritionist/foods',
      headers: auth(token),
      payload: {
        name: 'Bolo da Ana',
        groupId: foods.groups.cereals.id,
        portion: { label: '1 fatia', grams: 60 },
        per100g: CUSTOM_PER_100G,
        ...overrides,
      },
    });
  }

  async function createOwnedCustom() {
    const res = await createCustom(nutri.accessToken);
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  describe('GET /foods', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/foods?q=arroz' });

      expect(res.statusCode).toBe(401);
    });

    it('should return items with the Food shape (portion and per100g)', async () => {
      const items = await search(nutri.accessToken, `q=arroz&sources=${ALL_SOURCES}`);

      expect(items).toEqual([
        {
          id: foods.rice.id,
          name: 'Arroz, integral, cozido',
          source: Source.TACO,
          groupId: foods.groups.cereals.id,
          groupName: 'Cereais',
          portion: { label: '4 colheres de sopa', grams: 125 },
          per100g: { kcal: 124, protein: 2.6, carbs: 25.8, fat: 1, fiber: 2.7 },
        },
      ]);
    });

    it('should match without accents ("acai" finds "Açaí")', async () => {
      const items = await search(nutri.accessToken, `q=acai&sources=${ALL_SOURCES}`);

      expect(items.map((food) => food.name)).toEqual(['Açaí, polpa']);
    });

    it('should match accented queries against unaccented text and ignore case ("FEIJÃO")', async () => {
      const items = await search(nutri.accessToken, `q=${encodeURIComponent('FEIJÃO')}&sources=${ALL_SOURCES}`);

      expect(items.map((food) => food.id).sort()).toEqual([foods.beansTaco.id, foods.beansTbca.id].sort());
    });

    it('should return TACO and TBCA together when both sources are requested', async () => {
      const items = await search(nutri.accessToken, `q=feijao&sources=${Source.TACO},${Source.TBCA}`);

      expect(new Set(items.map((food) => food.source))).toEqual(new Set([Source.TACO, Source.TBCA]));
    });

    it('should restrict to the requested source', async () => {
      const items = await search(nutri.accessToken, `q=feijao&sources=${Source.TBCA}`);

      expect(items.map((food) => food.id)).toEqual([foods.beansTbca.id]);
    });

    it('should filter by group', async () => {
      const items = await search(nutri.accessToken, `groupId=${foods.groups.meats.id}&sources=${ALL_SOURCES}`);

      expect(items.map((food) => food.id).sort()).toEqual([foods.chicken.id, foods.patinho.id].sort());
    });

    it('should honour limit', async () => {
      const items = await search(nutri.accessToken, `sources=${ALL_SOURCES}&limit=2`);

      expect(items).toHaveLength(2);
    });
  });

  describe('GET /food-groups', () => {
    it('should return { items } with id, name and code', async () => {
      const res = await app.inject({ method: 'GET', url: '/food-groups', headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toContainEqual({ id: foods.groups.meats.id, name: 'Carnes', code: 'carnes' });
    });
  });

  describe('custom foods (Meus alimentos)', () => {
    it('should create a custom food and return the Food shape with source custom', async () => {
      const res = await createCustom(nutri.accessToken);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.any(String),
        name: 'Bolo da Ana',
        source: Source.CUSTOM,
        groupId: foods.groups.cereals.id,
        groupName: 'Cereais',
        portion: { label: '1 fatia', grams: 60 },
        per100g: CUSTOM_PER_100G,
      });
    });

    it('should show the custom food in the owner search with source custom', async () => {
      await createCustom(nutri.accessToken);

      const items = await search(nutri.accessToken, `q=bolo&sources=${Source.CUSTOM}`);

      expect(items).toEqual([expect.objectContaining({ name: 'Bolo da Ana', source: Source.CUSTOM })]);
    });

    it('should not show the custom food to another nutritionist', async () => {
      await createOwnedCustom();
      const other = await createNutritionist(app);

      const items = await search(other.accessToken, `q=bolo&sources=${ALL_SOURCES}`);

      expect(items).toEqual([]);
    });

    it('should not show the custom food to a plain user', async () => {
      await createOwnedCustom();
      const plain = await createUser(app);

      const items = await search(plain.accessToken, `q=bolo&sources=${ALL_SOURCES}`);

      expect(items).toEqual([]);
    });

    it('should not return custom foods when the custom source is not requested', async () => {
      await createOwnedCustom();

      const items = await search(nutri.accessToken, `q=bolo&sources=${Source.TACO},${Source.TBCA}`);

      expect(items).toEqual([]);
    });

    it('should answer 400 VALIDATION_ERROR when the name is missing', async () => {
      const res = await createCustom(nutri.accessToken, { name: undefined });

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 400 VALIDATION_ERROR for negative macros', async () => {
      const res = await createCustom(nutri.accessToken, { per100g: { ...CUSTOM_PER_100G, protein: -1 } });

      expect(res.statusCode).toBe(400);
    });

    it.each(PER_100G_OVER_LIMIT)('should answer 400 VALIDATION_ERROR when per100g.%s is above its column limit', async (nutrient, value) => {
      const res = await createCustom(nutri.accessToken, { per100g: { ...CUSTOM_PER_100G, [nutrient]: value } });

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should accept per100g exactly at the limits (100 g macros, 1000 kcal)', async () => {
      const res = await createCustom(nutri.accessToken, {
        per100g: { kcal: MAX_KCAL_PER_100G, protein: MAX_MACRO_PER_100G, carbs: MAX_MACRO_PER_100G, fat: MAX_MACRO_PER_100G, fiber: MAX_MACRO_PER_100G },
      });

      expect(res.statusCode).toBe(201);
    });

    it.each(PER_100G_OVER_LIMIT)('should answer 400 VALIDATION_ERROR when updating per100g.%s above its column limit', async (nutrient, value) => {
      const created = await createOwnedCustom();

      const res = await app.inject({
        method: 'PATCH',
        url: `/nutritionist/foods/${created.id}`,
        headers: auth(nutri.accessToken),
        payload: { per100g: { ...CUSTOM_PER_100G, [nutrient]: value } },
      });

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await createCustom(plain.accessToken);

      expect(res.statusCode).toBe(403);
    });

    it('should update an owned custom food', async () => {
      const created = await createOwnedCustom();

      const res = await app.inject({
        method: 'PATCH',
        url: `/nutritionist/foods/${created.id}`,
        headers: auth(nutri.accessToken),
        payload: { name: 'Bolo de cenoura', per100g: { ...CUSTOM_PER_100G, kcal: 400 } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: created.id, name: 'Bolo de cenoura', per100g: { kcal: 400 } });
    });

    it('should not let another nutritionist update the food', async () => {
      const created = await createOwnedCustom();
      const other = await createNutritionist(app);

      const res = await app.inject({
        method: 'PATCH',
        url: `/nutritionist/foods/${created.id}`,
        headers: auth(other.accessToken),
        payload: { name: 'Roubado' },
      });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should not let a nutritionist edit a public TACO food', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/nutritionist/foods/${foods.rice.id}`,
        headers: auth(nutri.accessToken),
        payload: { name: 'Arroz hackeado' },
      });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should delete an owned custom food with 204 and remove it from search', async () => {
      const created = await createOwnedCustom();

      const res = await app.inject({ method: 'DELETE', url: `/nutritionist/foods/${created.id}`, headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(204);
      expect(await search(nutri.accessToken, `q=bolo&sources=${Source.CUSTOM}`)).toEqual([]);
    });
  });
});

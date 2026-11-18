import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { createNutritionist, seedFoods, auth } from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const Source = Object.freeze({ TACO: 'taco', TBCA: 'tbca', CUSTOM: 'custom' });
const ANY_ENERGY_KCAL = 100;

e2eDescribe('e2e: GET /foods relevance ranking', () => {
  let app;
  let nutri;
  let groupId;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const foods = await seedFoods();
    groupId = foods.groups.cereals.id;
    nutri = await createNutritionist(app);
  });

  function createFood(name, source, extra = {}) {
    return prisma.food.create({ data: { foodGroupId: groupId, name, source, energyKcal: ANY_ENERGY_KCAL, ...extra } });
  }

  async function searchItems(query, extra = '') {
    const res = await app.inject({
      method: 'GET',
      url: `/foods?q=${encodeURIComponent(query)}${extra}`,
      headers: auth(nutri.accessToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json().items;
  }

  async function searchNames(query, extra = '') {
    return (await searchItems(query, extra)).map((item) => item.name);
  }

  it('should rank the simple cooked egg above composite dishes containing it', async () => {
    await createFood('Arroz, c/ ovo frito, c/ sal (arroz polido cozido, ovo frito, c/ sal)', Source.TACO);
    await createFood('Carne, moída, cozida, c/ azeitona, ovo cozido, c/ óleo, c/ sal', Source.TACO);
    await createFood('Ovo, de galinha, inteiro, cozido/10minutos', Source.TACO);

    const names = await searchNames('ovo cozido');

    expect(names[0]).toBe('Ovo, de galinha, inteiro, cozido/10minutos');
    expect(names).toHaveLength(3);
  });

  it('should rank the plain grilled chicken above a chicken burrito', async () => {
    await createFood('Burrito de frango, c/ tortilha (tortilha, c/ peito de frango grelhado, c/ sal)', Source.TACO);
    await createFood('Frango, peito, sem pele, grelhado', Source.TACO);

    const names = await searchNames('frango grelhado');

    expect(names.slice(0, 2)).toEqual(['Frango, filé, grelhado', 'Frango, peito, sem pele, grelhado']);
    expect(names[2]).toMatch(/^Burrito de frango/);
  });

  it('should rank names starting with the query above names merely containing it', async () => {
    await createFood('Abobrinha, à milanesa (farinha de trigo, ovo)', Source.TACO);
    await createFood('Bolo de ovo', Source.TACO);
    await createFood('Ovo, de galinha, inteiro, frito', Source.TACO);

    const names = await searchNames('ovo');

    expect(names[0]).toBe('Ovo, de galinha, inteiro, frito');
  });

  it('should rank whole-word matches above substring matches', async () => {
    await createFood('Ovomaltine, achocolatado', Source.TACO);
    await createFood('Ovo, cru', Source.TACO);

    const names = await searchNames('ovo');

    expect(names).toEqual(['Ovo, cru', 'Ovomaltine, achocolatado']);
  });

  it('should prefer fewer words and then non-composite names for same-prefix matches', async () => {
    await createFood('Ovo, c/ sal, frito', Source.TACO);
    await createFood('Ovo, inteiro, frito', Source.TACO);
    await createFood('Ovo, frito', Source.TACO);

    const names = await searchNames('ovo');

    expect(names).toEqual(['Ovo, frito', 'Ovo, inteiro, frito', 'Ovo, c/ sal, frito']);
  });

  it('should use source preference custom > taco as a tiebreaker and never return tbca', async () => {
    const nutritionist = await prisma.nutritionist.findUnique({ where: { userId: nutri.userId } });
    await createFood('Tapioca, goma', Source.TBCA);
    await createFood('Tapioca, goma', Source.TACO);
    await createFood('Tapioca, goma', Source.CUSTOM, { nutritionistId: nutritionist.id });

    const items = await searchItems('tapioca');

    expect(items.map((item) => item.source)).toEqual([Source.CUSTOM, Source.TACO]);
  });

  it('should keep accent-insensitive matching and respect the limit', async () => {
    await createFood('Açaí, polpa', Source.TACO);
    await createFood('Açaí, c/ granola', Source.TACO);

    const names = await searchNames('acai', '&limit=1');

    expect(names).toEqual(['Açaí, polpa']);
  });
});

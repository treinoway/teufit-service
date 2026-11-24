import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  searchFoods,
  getFoodById,
  listFoodGroups,
  createCustomFood,
  updateCustomFood,
  deleteCustomFood,
} from '../../src/services/food-service.js';
import { FoodSource, NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

const NUTRITIONIST_ID = 'nutri-1';
const FOOD_ID = 'food-1';
const GROUP_ID = 'group-1';
const HTTP_NOT_FOUND = 404;
const HIDDEN_SOURCES = [FoodSource.TBCA];

// Test helper: build a Food row as returned by Prisma.
function makeFood(overrides = {}) {
  return {
    id: FOOD_ID,
    name: 'Arroz',
    source: FoodSource.TACO,
    nutritionistId: null,
    foodGroupId: GROUP_ID,
    foodGroup: { id: GROUP_ID, name: 'Cereais' },
    energyKcal: 128,
    proteinG: 2.5,
    carbohydratesG: 28,
    totalFatG: 0.2,
    fiberG: 1.6,
    servingSizeG: 50,
    servingSizeDescription: '2 colheres',
    ...overrides,
  };
}

// Test helper: expected DTO of makeFood().
function makeFoodDto(overrides = {}) {
  return {
    id: FOOD_ID,
    name: 'Arroz',
    source: FoodSource.TACO,
    groupId: GROUP_ID,
    groupName: 'Cereais',
    portion: { label: '2 colheres', grams: 50 },
    per100g: { kcal: 128, protein: 2.5, carbs: 28, fat: 0.2, fiber: 1.6 },
    ...overrides,
  };
}

// Test helper: build a mocked prisma client.
function makePrisma() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    food: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    foodGroup: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ id: GROUP_ID }),
    },
  };
}

// Test helper: bound values of the WHERE clause (first interpolation) passed to $queryRaw; the ORDER BY binds every source.
function whereValues(db) {
  const [, whereClause] = db.$queryRaw.mock.calls[0];
  return Prisma.sql`${whereClause}`.values;
}

// Test helper: true when a row satisfies a Prisma where with equality, notIn and OR.
function matchesWhere(row, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((branch) => matchesWhere(row, branch));
    if (condition && typeof condition === 'object' && 'notIn' in condition) return !condition.notIn.includes(row[key]);
    return row[key] === condition;
  });
}

// Test helper: findFirst mock that applies the where to the given rows.
function findFirstOver(rows) {
  return async ({ where }) => rows.find((row) => matchesWhere(row, where)) ?? null;
}

describe('searchFoods', () => {
  let db;

  beforeEach(() => {
    db = makePrisma();
  });

  it('should return no items without querying when no source is visible', async () => {
    const result = await searchFoods(db, { sources: [] });

    expect(result).toEqual({ items: [] });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('should return no items for custom-only sources without a nutritionist', async () => {
    const result = await searchFoods(db, { sources: [FoodSource.CUSTOM], nutritionistId: null });

    expect(result).toEqual({ items: [] });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('should return no items and skip the food lookup when no id matches', async () => {
    const result = await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, query: 'xyz' });

    expect(result).toEqual({ items: [] });
    expect(db.food.findMany).not.toHaveBeenCalled();
  });

  it('should return foods in the order of the matched ids', async () => {
    db.$queryRaw.mockResolvedValue([{ id: 'b' }, { id: 'a' }]);
    db.food.findMany.mockResolvedValue([makeFood({ id: 'a', name: 'A' }), makeFood({ id: 'b', name: 'B' })]);

    const result = await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, query: 'a' });

    expect(result.items.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('should load the matched ids with their food group', async () => {
    db.$queryRaw.mockResolvedValue([{ id: FOOD_ID }]);
    db.food.findMany.mockResolvedValue([makeFood()]);

    await searchFoods(db, { nutritionistId: NUTRITIONIST_ID });

    expect(db.food.findMany).toHaveBeenCalledWith({
      where: { id: { in: [FOOD_ID] } },
      include: { foodGroup: { select: { id: true, name: true } } },
    });
  });

  it('should map foods to the Food contract shape', async () => {
    db.$queryRaw.mockResolvedValue([{ id: FOOD_ID }]);
    db.food.findMany.mockResolvedValue([makeFood()]);

    const result = await searchFoods(db, {});

    expect(result.items).toEqual([makeFoodDto()]);
  });

  it('should pass the default limit to the query when none is given', async () => {
    await searchFoods(db, {});

    const values = db.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(20);
  });

  it('should clamp an oversized limit to the maximum', async () => {
    await searchFoods(db, { limit: 5000 });

    const values = db.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(100);
  });

  describe('hidden sources (TBCA licensing)', () => {
    it('should not bind the tbca source in the default search', async () => {
      await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, query: 'feijao' });

      expect(whereValues(db)).not.toContain(FoodSource.TBCA);
    });

    it('should still bind the taco source in the default search', async () => {
      await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, query: 'feijao' });

      expect(whereValues(db)).toContain(FoodSource.TACO);
    });

    it('should return no items without querying when only tbca is requested', async () => {
      const result = await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, sources: [FoodSource.TBCA] });

      expect(result).toEqual({ items: [] });
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('should search taco only when tbca and taco are requested', async () => {
      await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, sources: [FoodSource.TBCA, FoodSource.TACO] });

      const values = whereValues(db);
      expect(values).toContain(FoodSource.TACO);
      expect(values).not.toContain(FoodSource.TBCA);
    });

    it('should still search custom foods when tbca and custom are requested', async () => {
      await searchFoods(db, { nutritionistId: NUTRITIONIST_ID, sources: [FoodSource.TBCA, FoodSource.CUSTOM] });

      const values = whereValues(db);
      expect(values).toContain(NUTRITIONIST_ID);
      expect(values).not.toContain(FoodSource.TBCA);
    });
  });
});

describe('getFoodById', () => {
  let db;

  beforeEach(() => {
    db = makePrisma();
  });

  it('should return the food DTO when it is accessible', async () => {
    db.food.findFirst.mockResolvedValue(makeFood());

    const result = await getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID });

    expect(result).toEqual(makeFoodDto());
  });

  it('should restrict visibility to non-hidden public foods and the caller custom foods', async () => {
    db.food.findFirst.mockResolvedValue(makeFood());

    await getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID });

    expect(db.food.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: FOOD_ID,
          OR: [{ nutritionistId: null, source: { notIn: HIDDEN_SOURCES } }, { nutritionistId: NUTRITIONIST_ID }],
        },
      }),
    );
  });

  it('should only see non-hidden public foods without a nutritionist', async () => {
    db.food.findFirst.mockResolvedValue(makeFood());

    await getFoodById(db, { foodId: FOOD_ID });

    expect(db.food.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FOOD_ID, OR: [{ nutritionistId: null, source: { notIn: HIDDEN_SOURCES } }] } }),
    );
  });

  it('should throw 404 FOOD_NOT_FOUND for a public TBCA food', async () => {
    db.food.findFirst.mockImplementation(findFirstOver([makeFood({ source: FoodSource.TBCA })]));

    await expect(getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID })).rejects.toMatchObject({
      httpStatus: HTTP_NOT_FOUND,
      error: NutritionErrorCode.FOOD_NOT_FOUND,
      messageCode: NutritionMessageCode.FOOD_NOT_FOUND,
    });
  });

  it('should still return a public TACO food', async () => {
    db.food.findFirst.mockImplementation(findFirstOver([makeFood()]));

    const result = await getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID });

    expect(result).toEqual(makeFoodDto());
  });

  it('should still return the caller own custom food', async () => {
    db.food.findFirst.mockImplementation(
      findFirstOver([makeFood({ source: FoodSource.CUSTOM, nutritionistId: NUTRITIONIST_ID })]),
    );

    const result = await getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID });

    expect(result).toEqual(makeFoodDto({ source: FoodSource.CUSTOM }));
  });

  it('should throw 404 FOOD_NOT_FOUND when the food is not accessible', async () => {
    await expect(getFoodById(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID })).rejects.toMatchObject({
      httpStatus: HTTP_NOT_FOUND,
      error: NutritionErrorCode.FOOD_NOT_FOUND,
      messageCode: NutritionMessageCode.FOOD_NOT_FOUND,
    });
  });
});

describe('listFoodGroups', () => {
  it('should return groups ordered by name with only id, name and code', async () => {
    const db = makePrisma();
    db.foodGroup.findMany.mockResolvedValue([{ id: GROUP_ID, name: 'Cereais', code: 'CER', extra: 'x' }]);

    const result = await listFoodGroups(db);

    expect(result).toEqual({ items: [{ id: GROUP_ID, name: 'Cereais', code: 'CER' }] });
    expect(db.foodGroup.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
  });
});

describe('createCustomFood', () => {
  let db;
  const data = {
    name: 'Meu bolo',
    groupId: GROUP_ID,
    per100g: { kcal: 300, protein: 5, carbs: 50, fat: 10, fiber: 2 },
    portion: { label: '1 fatia', grams: 60 },
  };

  beforeEach(() => {
    db = makePrisma();
  });

  it('should create a custom food owned by the nutritionist', async () => {
    db.food.create.mockResolvedValue(
      makeFood({ name: 'Meu bolo', source: FoodSource.CUSTOM, nutritionistId: NUTRITIONIST_ID }),
    );

    await createCustomFood(db, { nutritionistId: NUTRITIONIST_ID, data });

    expect(db.food.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nutritionistId: NUTRITIONIST_ID,
          foodGroupId: GROUP_ID,
          name: 'Meu bolo',
          source: FoodSource.CUSTOM,
          energyKcal: 300,
          proteinG: 5,
          carbohydratesG: 50,
          fiberG: 2,
          totalFatG: 10,
          servingSizeG: 60,
          servingSizeDescription: '1 fatia',
        },
      }),
    );
  });

  it('should return the created food as a DTO', async () => {
    db.food.create.mockResolvedValue(makeFood({ source: FoodSource.CUSTOM }));

    const result = await createCustomFood(db, { nutritionistId: NUTRITIONIST_ID, data });

    expect(result).toEqual(makeFoodDto({ source: FoodSource.CUSTOM }));
  });

  it('should throw 404 FOOD_GROUP_NOT_FOUND when the group does not exist', async () => {
    db.foodGroup.findUnique.mockResolvedValue(null);

    await expect(createCustomFood(db, { nutritionistId: NUTRITIONIST_ID, data })).rejects.toMatchObject({
      httpStatus: HTTP_NOT_FOUND,
      error: NutritionErrorCode.FOOD_GROUP_NOT_FOUND,
      messageCode: NutritionMessageCode.FOOD_GROUP_NOT_FOUND,
    });
    expect(db.food.create).not.toHaveBeenCalled();
  });
});

describe('updateCustomFood', () => {
  let db;

  beforeEach(() => {
    db = makePrisma();
    db.food.findFirst.mockResolvedValue(makeFood({ nutritionistId: NUTRITIONIST_ID }));
    db.food.update.mockResolvedValue(makeFood({ name: 'Novo' }));
  });

  it('should check ownership through the nutritionist id', async () => {
    await updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { name: 'Novo' } });

    expect(db.food.findFirst).toHaveBeenCalledWith({ where: { id: FOOD_ID, nutritionistId: NUTRITIONIST_ID } });
  });

  it('should only update the provided fields', async () => {
    await updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { name: 'Novo' } });

    expect(db.food.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: FOOD_ID }, data: { name: 'Novo' } }));
  });

  it('should map the group id to the food group column after validating it', async () => {
    await updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { groupId: 'group-2' } });

    expect(db.foodGroup.findUnique).toHaveBeenCalledWith({ where: { id: 'group-2' }, select: { id: true } });
    expect(db.food.update).toHaveBeenCalledWith(expect.objectContaining({ data: { foodGroupId: 'group-2' } }));
  });

  it('should return the updated food as a DTO', async () => {
    const result = await updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { name: 'Novo' } });

    expect(result).toEqual(makeFoodDto({ name: 'Novo' }));
  });

  it('should throw 404 FOOD_NOT_FOUND when the food is not owned by the nutritionist', async () => {
    db.food.findFirst.mockResolvedValue(null);

    await expect(
      updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { name: 'Novo' } }),
    ).rejects.toMatchObject({ httpStatus: HTTP_NOT_FOUND, error: NutritionErrorCode.FOOD_NOT_FOUND });
    expect(db.food.update).not.toHaveBeenCalled();
  });

  it('should throw 404 FOOD_GROUP_NOT_FOUND when the new group does not exist', async () => {
    db.foodGroup.findUnique.mockResolvedValue(null);

    await expect(
      updateCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID, data: { groupId: 'missing' } }),
    ).rejects.toMatchObject({ httpStatus: HTTP_NOT_FOUND, error: NutritionErrorCode.FOOD_GROUP_NOT_FOUND });
    expect(db.food.update).not.toHaveBeenCalled();
  });
});

describe('deleteCustomFood', () => {
  let db;

  beforeEach(() => {
    db = makePrisma();
  });

  it('should delete an owned custom food', async () => {
    db.food.findFirst.mockResolvedValue(makeFood({ nutritionistId: NUTRITIONIST_ID }));

    await deleteCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID });

    expect(db.food.delete).toHaveBeenCalledWith({ where: { id: FOOD_ID } });
  });

  it('should throw 404 FOOD_NOT_FOUND and not delete when the food is not owned', async () => {
    await expect(deleteCustomFood(db, { nutritionistId: NUTRITIONIST_ID, foodId: FOOD_ID })).rejects.toMatchObject({
      httpStatus: HTTP_NOT_FOUND,
      error: NutritionErrorCode.FOOD_NOT_FOUND,
    });
    expect(db.food.delete).not.toHaveBeenCalled();
  });
});

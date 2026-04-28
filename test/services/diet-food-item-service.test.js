import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    nutritionist: { findUnique: vi.fn() },
    dietMeal: { findUnique: vi.fn() },
    food: { findUnique: vi.fn() },
    dietFoodItem: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createFoodItem,
  updateFoodItem,
  deleteFoodItem,
} from '../../src/services/diet-food-item-service.js';
import { DietErrorCode, DietMessageCode } from '../../src/constants/diet.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────

const NUTRITIONIST_USER_ID = 'user-nutri-1';
const NUTRITIONIST_ID = 'nutri-1';
const MEAL_ID = 'meal-1';
const FOOD_ID = 'food-1';
const FOOD_ITEM_ID = 'item-1';

const stubNutritionist = { id: NUTRITIONIST_ID };

const stubMeal = {
  id: MEAL_ID,
  deletedAt: null,
  protocol: { nutritionistId: NUTRITIONIST_ID, deletedAt: null },
};

const stubFood = {
  name: 'Frango Grelhado',
  energyKcal: '165',   // Prisma Decimal — stored as string-like
  proteinG: '31',
  carbohydratesG: '0',
  totalFatG: '3.6',
  fiberG: null,
};

const stubCreatedItem = {
  id: FOOD_ITEM_ID,
  dietMealId: MEAL_ID,
  foodId: FOOD_ID,
  foodName: 'Frango Grelhado',
  quantityG: '100',
  unit: 'g',
  order: 0,
  energyKcal: '165',
  proteinG: '31',
  carbohydratesG: '0',
  totalFatG: '3.6',
  fiberG: null,
  deletedAt: null,
  food: { id: FOOD_ID, name: 'Frango Grelhado' },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.nutritionist.findUnique.mockResolvedValue(stubNutritionist);
  prisma.dietMeal.findUnique.mockResolvedValue(stubMeal);
  prisma.food.findUnique.mockResolvedValue(stubFood);
  prisma.dietFoodItem.create.mockResolvedValue(stubCreatedItem);
});

// ─── createFoodItem ─────────────────────────────────────────────────────────

describe('createFoodItem', () => {
  describe('nutritionist resolution', () => {
    it('throws NUTRITIONIST_NOT_FOUND when nutritionist profile does not exist', async () => {
      prisma.nutritionist.findUnique.mockResolvedValue(null);

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: FOOD_ID, quantityG: 100 }),
      ).rejects.toMatchObject({
        code: 'NUTRITIONIST_NOT_FOUND',
        statusCode: 404,
      });

      expect(prisma.dietFoodItem.create).not.toHaveBeenCalled();
    });
  });

  describe('meal resolution and ownership', () => {
    it('throws MEAL_NOT_FOUND when meal does not exist', async () => {
      prisma.dietMeal.findUnique.mockResolvedValue(null);

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: FOOD_ID, quantityG: 100 }),
      ).rejects.toMatchObject({
        code: DietErrorCode.MEAL_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('throws MEAL_NOT_FOUND when meal is soft-deleted', async () => {
      prisma.dietMeal.findUnique.mockResolvedValue({ ...stubMeal, deletedAt: new Date() });

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: FOOD_ID, quantityG: 100 }),
      ).rejects.toMatchObject({
        code: DietErrorCode.MEAL_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when protocol belongs to another nutritionist', async () => {
      prisma.dietMeal.findUnique.mockResolvedValue({
        ...stubMeal,
        protocol: { nutritionistId: 'other-nutri', deletedAt: null },
      });

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: FOOD_ID, quantityG: 100 }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when parent protocol is soft-deleted', async () => {
      prisma.dietMeal.findUnique.mockResolvedValue({
        ...stubMeal,
        protocol: { nutritionistId: NUTRITIONIST_ID, deletedAt: new Date() },
      });

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: FOOD_ID, quantityG: 100 }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        statusCode: 403,
      });
    });
  });

  describe('food snapshot with foodId', () => {
    it('throws FOOD_NOT_FOUND when the referenced food does not exist', async () => {
      prisma.food.findUnique.mockResolvedValue(null);

      await expect(
        createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, { foodId: 'ghost-food', quantityG: 100 }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FOOD_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('calculates proportional snapshot for 200g of food (values per 100g)', async () => {
      prisma.dietFoodItem.create.mockImplementation(async ({ data }) => ({ ...data, id: FOOD_ITEM_ID, food: null }));

      const result = await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodId: FOOD_ID,
        quantityG: 200,
      });

      // energyKcal per 100g = 165 → for 200g = 330
      expect(result.energyKcal).toBeCloseTo(330, 2);
      // proteinG per 100g = 31 → for 200g = 62
      expect(result.proteinG).toBeCloseTo(62, 2);
      // totalFatG per 100g = 3.6 → for 200g = 7.2
      expect(result.totalFatG).toBeCloseTo(7.2, 2);
      // fiberG is null → should remain null
      expect(result.fiberG).toBeNull();
    });

    it('scales to exactly zero for 0g quantity', async () => {
      prisma.dietFoodItem.create.mockImplementation(async ({ data }) => ({ ...data, id: FOOD_ITEM_ID, food: null }));

      const result = await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodId: FOOD_ID,
        quantityG: 0,
      });

      expect(result.energyKcal).toBe(0);
      expect(result.proteinG).toBe(0);
    });

    it('persists foodName from food record when not overridden', async () => {
      prisma.dietFoodItem.create.mockImplementation(async ({ data }) => ({ ...data, id: FOOD_ITEM_ID, food: null }));

      const result = await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodId: FOOD_ID,
        quantityG: 100,
      });

      expect(result.foodName).toBe(stubFood.name);
    });

    it('uses override foodName when provided', async () => {
      prisma.dietFoodItem.create.mockImplementation(async ({ data }) => ({ ...data, id: FOOD_ITEM_ID, food: null }));

      const result = await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodId: FOOD_ID,
        quantityG: 100,
        foodName: 'Peito de Frango',
      });

      expect(result.foodName).toBe('Peito de Frango');
    });

    it('calls db.dietFoodItem.create with foodId set', async () => {
      await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodId: FOOD_ID,
        quantityG: 100,
      });

      expect(prisma.dietFoodItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ foodId: FOOD_ID, dietMealId: MEAL_ID }),
        }),
      );
    });
  });

  describe('food snapshot without foodId (manual entry)', () => {
    it('creates item with manually provided nutritional values when no foodId', async () => {
      prisma.dietFoodItem.create.mockImplementation(async ({ data }) => ({ ...data, id: FOOD_ITEM_ID, food: null }));

      const result = await createFoodItem(prisma, NUTRITIONIST_USER_ID, MEAL_ID, {
        foodName: 'Suplemento X',
        quantityG: 30,
        energyKcal: 120,
        proteinG: 25,
        carbohydratesG: 3,
        totalFatG: 1.5,
        fiberG: 0,
      });

      expect(result.energyKcal).toBe(120);
      expect(result.proteinG).toBe(25);
      expect(result.foodId).toBeFalsy();
      // food lookup should NOT happen when no foodId is passed
      expect(prisma.food.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ─── updateFoodItem ─────────────────────────────────────────────────────────

describe('updateFoodItem', () => {
  const stubFoodItemInDb = {
    id: FOOD_ITEM_ID,
    foodId: FOOD_ID,
    quantityG: '100',
    deletedAt: null,
    meal: {
      protocol: { nutritionistId: NUTRITIONIST_ID, deletedAt: null },
    },
  };

  beforeEach(() => {
    prisma.dietFoodItem.findUnique.mockResolvedValue(stubFoodItemInDb);
    prisma.dietFoodItem.update.mockResolvedValue({ ...stubFoodItemInDb, food: null });
  });

  describe('authorization checks', () => {
    it('throws NUTRITIONIST_NOT_FOUND when nutritionist profile is missing', async () => {
      prisma.nutritionist.findUnique.mockResolvedValue(null);

      await expect(
        updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'New Name' }),
      ).rejects.toMatchObject({
        code: 'NUTRITIONIST_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FOOD_ITEM_NOT_FOUND when item does not exist', async () => {
      prisma.dietFoodItem.findUnique.mockResolvedValue(null);

      await expect(
        updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'New Name' }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FOOD_ITEM_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('throws FOOD_ITEM_NOT_FOUND when item is soft-deleted', async () => {
      prisma.dietFoodItem.findUnique.mockResolvedValue({ ...stubFoodItemInDb, deletedAt: new Date() });

      await expect(
        updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'New Name' }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FOOD_ITEM_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when protocol belongs to another nutritionist', async () => {
      prisma.dietFoodItem.findUnique.mockResolvedValue({
        ...stubFoodItemInDb,
        meal: { protocol: { nutritionistId: 'other-nutri', deletedAt: null } },
      });

      await expect(
        updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'New Name' }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when parent protocol is soft-deleted', async () => {
      prisma.dietFoodItem.findUnique.mockResolvedValue({
        ...stubFoodItemInDb,
        meal: { protocol: { nutritionistId: NUTRITIONIST_ID, deletedAt: new Date() } },
      });

      await expect(
        updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'New Name' }),
      ).rejects.toMatchObject({
        code: DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
        statusCode: 403,
      });
    });
  });

  describe('snapshot recalculation on quantityG change', () => {
    it('recalculates snapshot when quantityG changes and item has a foodId', async () => {
      prisma.dietFoodItem.update.mockImplementation(async ({ data }) => ({
        ...stubFoodItemInDb,
        ...data,
        food: null,
      }));

      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { quantityG: 200 });

      expect(prisma.dietFoodItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quantityG: 200,
            energyKcal: expect.any(Number),
            proteinG: expect.any(Number),
          }),
        }),
      );
    });

    it('recalculated snapshot for 200g matches proportional values', async () => {
      let captured;
      prisma.dietFoodItem.update.mockImplementation(async ({ data }) => {
        captured = data;
        return { ...stubFoodItemInDb, ...data, food: null };
      });

      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { quantityG: 200 });

      // energyKcal 165/100g * 200g = 330
      expect(captured.energyKcal).toBeCloseTo(330, 2);
      // proteinG 31/100g * 200g = 62
      expect(captured.proteinG).toBeCloseTo(62, 2);
      // fiberG is null → remains null
      expect(captured.fiberG).toBeNull();
    });

    it('does not recalculate snapshot when only foodName changes', async () => {
      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { foodName: 'Frango Cozido' });

      expect(prisma.food.findUnique).not.toHaveBeenCalled();
      expect(prisma.dietFoodItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ foodName: 'Frango Cozido' }),
        }),
      );
      // energyKcal should NOT be in the update payload
      expect(prisma.dietFoodItem.update.mock.calls[0][0].data).not.toHaveProperty('energyKcal');
    });

    it('uses new foodId for snapshot when both quantityG and foodId are provided', async () => {
      const newFoodId = 'food-2';
      const newFoodStub = {
        name: 'Atum',
        energyKcal: '130',
        proteinG: '28',
        carbohydratesG: '0',
        totalFatG: '2',
        fiberG: null,
      };
      prisma.food.findUnique.mockResolvedValue(newFoodStub);
      let captured;
      prisma.dietFoodItem.update.mockImplementation(async ({ data }) => {
        captured = data;
        return { ...stubFoodItemInDb, ...data, food: null };
      });

      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, {
        foodId: newFoodId,
        quantityG: 100,
      });

      expect(prisma.food.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: newFoodId } }),
      );
      expect(captured.energyKcal).toBeCloseTo(130, 2);
    });

    it('does not recalculate snapshot when quantityG changes but item has no foodId', async () => {
      prisma.dietFoodItem.findUnique.mockResolvedValue({
        ...stubFoodItemInDb,
        foodId: null,
      });

      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { quantityG: 200 });

      expect(prisma.food.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('manual nutrient override without quantityG', () => {
    it('applies manual energyKcal override when no quantityG change', async () => {
      let captured;
      prisma.dietFoodItem.update.mockImplementation(async ({ data }) => {
        captured = data;
        return { ...stubFoodItemInDb, ...data, food: null };
      });

      await updateFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID, { energyKcal: 200 });

      expect(captured.energyKcal).toBe(200);
    });
  });
});

// ─── deleteFoodItem ─────────────────────────────────────────────────────────

describe('deleteFoodItem', () => {
  const stubFoodItemInDb = {
    id: FOOD_ITEM_ID,
    deletedAt: null,
    meal: {
      protocol: { nutritionistId: NUTRITIONIST_ID, deletedAt: null },
    },
  };

  beforeEach(() => {
    prisma.dietFoodItem.findUnique.mockResolvedValue(stubFoodItemInDb);
    prisma.dietFoodItem.update.mockResolvedValue({ ...stubFoodItemInDb, deletedAt: new Date() });
  });

  it('throws NUTRITIONIST_NOT_FOUND when nutritionist profile is missing', async () => {
    prisma.nutritionist.findUnique.mockResolvedValue(null);

    await expect(
      deleteFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID),
    ).rejects.toMatchObject({
      code: 'NUTRITIONIST_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('throws FOOD_ITEM_NOT_FOUND when item does not exist', async () => {
    prisma.dietFoodItem.findUnique.mockResolvedValue(null);

    await expect(
      deleteFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID),
    ).rejects.toMatchObject({
      code: DietErrorCode.FOOD_ITEM_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('throws FOOD_ITEM_NOT_FOUND when item is already soft-deleted', async () => {
    prisma.dietFoodItem.findUnique.mockResolvedValue({ ...stubFoodItemInDb, deletedAt: new Date() });

    await expect(
      deleteFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID),
    ).rejects.toMatchObject({
      code: DietErrorCode.FOOD_ITEM_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when another nutritionist owns the protocol', async () => {
    prisma.dietFoodItem.findUnique.mockResolvedValue({
      ...stubFoodItemInDb,
      meal: { protocol: { nutritionistId: 'other-nutri', deletedAt: null } },
    });

    await expect(
      deleteFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID),
    ).rejects.toMatchObject({
      code: DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      statusCode: 403,
    });
  });

  it('soft-deletes the item by setting deletedAt', async () => {
    const result = await deleteFoodItem(prisma, NUTRITIONIST_USER_ID, FOOD_ITEM_ID);

    expect(prisma.dietFoodItem.update).toHaveBeenCalledWith({
      where: { id: FOOD_ITEM_ID },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result.deletedAt).toBeInstanceOf(Date);
  });
});

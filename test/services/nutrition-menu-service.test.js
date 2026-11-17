import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NutritionErrorCode, NutritionMessageCode, MAX_MEAL_OPTIONS } from '../../src/constants/nutrition.js';

vi.mock('../../src/services/nutrition-plan-access.js', () => ({
  loadPlanView: vi.fn(),
  markPlanChanged: vi.fn(),
  requireOwnedPlan: vi.fn(),
  requireOwnedMeal: vi.fn(),
  requireOwnedOption: vi.fn(),
  requireOwnedItem: vi.fn(),
  requireOwnedSubstitute: vi.fn(),
}));
vi.mock('../../src/services/food-service.js', () => ({ requireAccessibleFood: vi.fn() }));

const access = await import('../../src/services/nutrition-plan-access.js');
const { requireAccessibleFood } = await import('../../src/services/food-service.js');
const menu = await import('../../src/services/nutrition-menu-service.js');

const NUTRITIONIST_ID = 'nutri-1';
const PLAN_ID = 'plan-1';
const MEAL_ID = 'meal-1';
const OPTION_ID = 'option-1';
const ITEM_ID = 'item-1';
const SUBSTITUTE_ID = 'sub-1';
const UNPROCESSABLE = 422;
const PLAN_VIEW = { id: PLAN_ID, meals: [] };
const CHICKEN_QUANTITY = 120;
const CHICKEN_PROTEIN_PER_100G = 32;
const LEAN_BEEF_PROTEIN_PER_100G = 35.9;
const EQUIVALENT_LEAN_BEEF_QUANTITY = 106.96;

// Test helper: builds a mocked prisma whose transaction runs the callback with itself.
function makePrisma() {
  const prisma = {
    dietMeal: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dietMealOption: { create: vi.fn(), delete: vi.fn() },
    dietFoodItem: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dietItemSubstitute: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  prisma.$transaction = vi.fn((callback) => callback(prisma));
  return prisma;
}

// Test helper: builds an item row with snapshot nutrients.
function makeItemRow(overrides = {}) {
  return {
    id: ITEM_ID,
    foodId: 'food-chicken',
    name: 'Chicken',
    source: 'TACO',
    householdMeasure: null,
    quantity: CHICKEN_QUANTITY,
    unit: 'g',
    kcalPer100g: 160,
    proteinPer100g: CHICKEN_PROTEIN_PER_100G,
    carbsPer100g: 0,
    fatPer100g: 3,
    fiberPer100g: 0,
    swapBasis: 'protein',
    order: 0,
    substitutes: [],
    ...overrides,
  };
}

// Test helper: builds a substitute row with snapshot nutrients.
function makeSubstituteRow(overrides = {}) {
  return {
    id: SUBSTITUTE_ID,
    foodId: 'food-beef',
    name: 'Lean beef',
    source: 'TACO',
    householdMeasure: null,
    quantity: 100,
    kcalPer100g: 150,
    proteinPer100g: LEAN_BEEF_PROTEIN_PER_100G,
    carbsPer100g: 0,
    fatPer100g: 5,
    fiberPer100g: 0,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

// Test helper: builds a Food row.
function makeFood(overrides = {}) {
  return {
    id: 'food-1',
    name: 'Rice',
    source: 'TACO',
    servingSizeG: null,
    servingSizeDescription: null,
    energyKcal: 130,
    proteinG: 2.5,
    carbohydratesG: 28,
    totalFatG: 0.3,
    fiberG: 0.4,
    ...overrides,
  };
}

// Test helper: builds a meal with options at the given positions.
function makeMeal(positions) {
  const substitute = makeSubstituteRow();
  const options = positions.map((position) => ({
    id: `option-${position}`,
    position,
    items: position === 1 ? [makeItemRow({ substitutes: [substitute] })] : [],
  }));
  return { id: MEAL_ID, dietProtocolId: PLAN_ID, options };
}

// Test helper: builds an item with the option and meal relations.
function makeOwnedItem(overrides = {}) {
  const item = makeItemRow({ substitutes: [makeSubstituteRow()], ...overrides });
  const siblings = [item, { id: 'item-2', order: 1 }, { id: 'item-3', order: 2 }];
  return { ...item, option: { items: siblings, meal: { dietProtocolId: PLAN_ID } } };
}

// Test helper: asserts the plan was flagged as changed inside the transaction.
function expectPlanMarked(prisma) {
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(access.markPlanChanged).toHaveBeenCalledWith(prisma, PLAN_ID);
}

describe('nutrition-menu-service', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
    access.loadPlanView.mockResolvedValue(PLAN_VIEW);
  });

  describe('createMeal', () => {
    it('should create the meal after the last one with one empty first option', async () => {
      prisma.dietMeal.findFirst.mockResolvedValue({ order: 2 });

      const result = await menu.createMeal(prisma, {
        nutritionistId: NUTRITIONIST_ID,
        planId: PLAN_ID,
        data: { name: 'Lunch', time: '12:00' },
      });

      expect(prisma.dietMeal.create).toHaveBeenCalledWith({
        data: {
          dietProtocolId: PLAN_ID,
          name: 'Lunch',
          time: '12:00',
          tip: null,
          order: 3,
          options: { create: { position: 1 } },
        },
      });
      expect(result).toBe(PLAN_VIEW);
      expectPlanMarked(prisma);
    });

    it('should start at order 0 when the plan has no meals', async () => {
      prisma.dietMeal.findFirst.mockResolvedValue(null);

      await menu.createMeal(prisma, {
        nutritionistId: NUTRITIONIST_ID,
        planId: PLAN_ID,
        data: { name: 'Breakfast', time: '07:00', tip: 'Drink water' },
      });

      const { data } = prisma.dietMeal.create.mock.calls[0][0];
      expect(data.order).toBe(0);
      expect(data.tip).toBe('Drink water');
    });
  });

  describe('updateMeal', () => {
    beforeEach(() => {
      access.requireOwnedMeal.mockResolvedValue({ id: MEAL_ID, dietProtocolId: PLAN_ID });
    });

    it('should update only the provided fields', async () => {
      await menu.updateMeal(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID, data: { name: 'Dinner' } });

      expect(prisma.dietMeal.update).toHaveBeenCalledWith({ where: { id: MEAL_ID }, data: { name: 'Dinner' } });
      expectPlanMarked(prisma);
    });

    it('should allow clearing the tip with null', async () => {
      await menu.updateMeal(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID, data: { tip: null } });

      expect(prisma.dietMeal.update).toHaveBeenCalledWith({ where: { id: MEAL_ID }, data: { tip: null } });
    });
  });

  describe('deleteMeal', () => {
    it('should delete the meal and flag the plan', async () => {
      access.requireOwnedMeal.mockResolvedValue({ id: MEAL_ID, dietProtocolId: PLAN_ID });

      const result = await menu.deleteMeal(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });

      expect(prisma.dietMeal.delete).toHaveBeenCalledWith({ where: { id: MEAL_ID } });
      expect(result).toBe(PLAN_VIEW);
      expectPlanMarked(prisma);
    });
  });

  describe('reorderMeals', () => {
    beforeEach(() => {
      prisma.dietMeal.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    });

    it('should renumber the orders following the given ids', async () => {
      await menu.reorderMeals(prisma, { nutritionistId: NUTRITIONIST_ID, planId: PLAN_ID, mealIds: ['c', 'a', 'b'] });

      expect(prisma.dietMeal.update).toHaveBeenNthCalledWith(1, { where: { id: 'c' }, data: { order: 0 } });
      expect(prisma.dietMeal.update).toHaveBeenNthCalledWith(2, { where: { id: 'a' }, data: { order: 1 } });
      expect(prisma.dietMeal.update).toHaveBeenNthCalledWith(3, { where: { id: 'b' }, data: { order: 2 } });
      expectPlanMarked(prisma);
    });

    it.each([
      ['a meal is missing', ['a', 'b']],
      ['an id is unknown', ['a', 'b', 'x']],
      ['an id is repeated', ['a', 'a', 'b']],
      ['there are extra ids', ['a', 'b', 'c', 'd']],
    ])('should throw 422 invalidOrder when %s', async (_label, mealIds) => {
      const promise = menu.reorderMeals(prisma, { nutritionistId: NUTRITIONIST_ID, planId: PLAN_ID, mealIds });

      await expect(promise).rejects.toMatchObject({
        httpStatus: UNPROCESSABLE,
        error: NutritionErrorCode.MEAL_INVALID_ORDER,
        messageCode: NutritionMessageCode.MEAL_INVALID_ORDER,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(access.markPlanChanged).not.toHaveBeenCalled();
    });
  });

  describe('addOption', () => {
    it('should copy option 1 items and substitutes into the lowest free position', async () => {
      access.requireOwnedMeal.mockResolvedValue(makeMeal([1, 3]));

      await menu.addOption(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });

      const { data } = prisma.dietMealOption.create.mock.calls[0][0];
      expect(data.mealId).toBe(MEAL_ID);
      expect(data.position).toBe(2);
      expect(data.items.create).toHaveLength(1);
      expect(data.items.create[0]).toMatchObject({ foodId: 'food-chicken', quantity: CHICKEN_QUANTITY, kcalPer100g: 160 });
      expect(data.items.create[0].substitutes.create).toEqual([
        expect.objectContaining({ foodId: 'food-beef', quantity: 100, proteinPer100g: LEAN_BEEF_PROTEIN_PER_100G }),
      ]);
      expectPlanMarked(prisma);
    });

    it('should lock the plan row and re-read the meal inside the transaction', async () => {
      access.requireOwnedMeal.mockResolvedValue(makeMeal([1]));

      await menu.addOption(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(access.requireOwnedMeal).toHaveBeenCalledTimes(2);
      expect(access.requireOwnedMeal).toHaveBeenLastCalledWith(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });
    });

    it('should reject using the meal re-read under the lock, not the one read before it', async () => {
      access.requireOwnedMeal.mockResolvedValueOnce(makeMeal([1])).mockResolvedValueOnce(makeMeal([1, 2, 3]));

      const promise = menu.addOption(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });

      await expect(promise).rejects.toMatchObject({ error: NutritionErrorCode.MEAL_MAX_OPTIONS });
      expect(prisma.dietMealOption.create).not.toHaveBeenCalled();
    });

    it('should throw 422 maxOptions when the meal already has the maximum options', async () => {
      access.requireOwnedMeal.mockResolvedValue(makeMeal([1, 2, 3]));

      const promise = menu.addOption(prisma, { nutritionistId: NUTRITIONIST_ID, mealId: MEAL_ID });

      await expect(promise).rejects.toMatchObject({
        httpStatus: UNPROCESSABLE,
        error: NutritionErrorCode.MEAL_MAX_OPTIONS,
        messageCode: NutritionMessageCode.MEAL_MAX_OPTIONS,
      });
      expect(MAX_MEAL_OPTIONS).toBe(3);
      expect(prisma.dietMealOption.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteOption', () => {
    it('should throw 422 firstOptionRequired for position 1', async () => {
      access.requireOwnedOption.mockResolvedValue({ id: OPTION_ID, position: 1, meal: { dietProtocolId: PLAN_ID } });

      const promise = menu.deleteOption(prisma, { nutritionistId: NUTRITIONIST_ID, optionId: OPTION_ID });

      await expect(promise).rejects.toMatchObject({
        httpStatus: UNPROCESSABLE,
        error: NutritionErrorCode.MEAL_FIRST_OPTION_REQUIRED,
        messageCode: NutritionMessageCode.MEAL_FIRST_OPTION_REQUIRED,
      });
      expect(prisma.dietMealOption.delete).not.toHaveBeenCalled();
    });

    it('should delete a non-first option and flag the plan', async () => {
      access.requireOwnedOption.mockResolvedValue({ id: OPTION_ID, position: 2, meal: { dietProtocolId: PLAN_ID } });

      await menu.deleteOption(prisma, { nutritionistId: NUTRITIONIST_ID, optionId: OPTION_ID });

      expect(prisma.dietMealOption.delete).toHaveBeenCalledWith({ where: { id: OPTION_ID } });
      expectPlanMarked(prisma);
    });
  });

  describe('addItem', () => {
    beforeEach(() => {
      access.requireOwnedOption.mockResolvedValue({
        id: OPTION_ID,
        meal: { dietProtocolId: PLAN_ID },
        items: [{ order: 0 }, { order: 4 }],
      });
    });

    it('should default to the food portion, gram unit, protein swap basis and next order', async () => {
      requireAccessibleFood.mockResolvedValue(makeFood({ servingSizeG: 150, servingSizeDescription: '1 cup' }));

      await menu.addItem(prisma, { nutritionistId: NUTRITIONIST_ID, optionId: OPTION_ID, data: { foodId: 'food-1' } });

      expect(prisma.dietFoodItem.create).toHaveBeenCalledWith({
        data: {
          dietMealOptionId: OPTION_ID,
          foodId: 'food-1',
          source: 'TACO',
          name: 'Rice',
          householdMeasure: '1 cup',
          quantity: 150,
          unit: 'g',
          swapBasis: 'protein',
          order: 5,
          kcalPer100g: 130,
          proteinPer100g: 2.5,
          carbsPer100g: 28,
          fatPer100g: 0.3,
          fiberPer100g: 0.4,
        },
      });
      expectPlanMarked(prisma);
    });

    it('should use the explicit quantity, unit and measure over the defaults', async () => {
      requireAccessibleFood.mockResolvedValue(makeFood({ servingSizeG: 150, servingSizeDescription: '1 cup' }));

      await menu.addItem(prisma, {
        nutritionistId: NUTRITIONIST_ID,
        optionId: OPTION_ID,
        data: { foodId: 'food-1', quantity: 200, unit: 'ml', householdMeasure: '2 scoops' },
      });

      const { data } = prisma.dietFoodItem.create.mock.calls[0][0];
      expect(data).toMatchObject({ quantity: 200, unit: 'ml', householdMeasure: '2 scoops' });
    });

    it('should fall back to 100 g and a null measure when the food has no serving size', async () => {
      requireAccessibleFood.mockResolvedValue(makeFood());

      await menu.addItem(prisma, { nutritionistId: NUTRITIONIST_ID, optionId: OPTION_ID, data: { foodId: 'food-1' } });

      const { data } = prisma.dietFoodItem.create.mock.calls[0][0];
      expect(data).toMatchObject({ quantity: 100, householdMeasure: null });
    });

    it('should start at order 0 in an empty option', async () => {
      access.requireOwnedOption.mockResolvedValue({ id: OPTION_ID, meal: { dietProtocolId: PLAN_ID }, items: [] });
      requireAccessibleFood.mockResolvedValue(makeFood());

      await menu.addItem(prisma, { nutritionistId: NUTRITIONIST_ID, optionId: OPTION_ID, data: { foodId: 'food-1' } });

      expect(prisma.dietFoodItem.create.mock.calls[0][0].data.order).toBe(0);
    });
  });

  describe('updateItem', () => {
    it('should update only the provided scalar fields without recomputing substitutes', async () => {
      access.requireOwnedItem.mockResolvedValue(makeOwnedItem());

      await menu.updateItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, data: { unit: 'ml' } });

      expect(prisma.dietFoodItem.update).toHaveBeenCalledWith({ where: { id: ITEM_ID }, data: { unit: 'ml' } });
      expect(prisma.dietItemSubstitute.update).not.toHaveBeenCalled();
      expectPlanMarked(prisma);
    });

    it('should recompute substitute quantities when the quantity changes', async () => {
      access.requireOwnedItem.mockResolvedValue(makeOwnedItem());

      await menu.updateItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, data: { quantity: CHICKEN_QUANTITY } });

      expect(prisma.dietItemSubstitute.update).toHaveBeenCalledWith({
        where: { id: SUBSTITUTE_ID },
        data: { quantity: EQUIVALENT_LEAN_BEEF_QUANTITY },
      });
    });

    it('should recompute substitute quantities when the swap basis changes', async () => {
      access.requireOwnedItem.mockResolvedValue(makeOwnedItem());

      await menu.updateItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, data: { swapBasis: 'kcal' } });

      const expectedKcalQuantity = 128;
      expect(prisma.dietItemSubstitute.update).toHaveBeenCalledWith({
        where: { id: SUBSTITUTE_ID },
        data: { quantity: expectedKcalQuantity },
      });
    });

    it('should renumber the siblings when the order changes', async () => {
      access.requireOwnedItem.mockResolvedValue(makeOwnedItem());

      await menu.updateItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, data: { order: 2 } });

      const orderUpdates = prisma.dietFoodItem.update.mock.calls.slice(1).map(([arg]) => [arg.where.id, arg.data.order]);
      expect(orderUpdates).toEqual([
        ['item-2', 0],
        ['item-3', 1],
        [ITEM_ID, 2],
      ]);
    });

    it('should clamp an out-of-range order to the end of the list', async () => {
      access.requireOwnedItem.mockResolvedValue(makeOwnedItem());

      await menu.updateItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, data: { order: 99 } });

      const lastUpdate = prisma.dietFoodItem.update.mock.calls.at(-1)[0];
      expect(lastUpdate).toEqual({ where: { id: ITEM_ID }, data: { order: 2 } });
    });
  });

  describe('deleteItem', () => {
    it('should delete the item and flag the plan', async () => {
      access.requireOwnedItem.mockResolvedValue({ id: ITEM_ID, option: { meal: { dietProtocolId: PLAN_ID } } });

      await menu.deleteItem(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID });

      expect(prisma.dietFoodItem.delete).toHaveBeenCalledWith({ where: { id: ITEM_ID } });
      expectPlanMarked(prisma);
    });
  });

  describe('addSubstitute', () => {
    it('should create the substitute with the quantity equalizing the item protein', async () => {
      access.requireOwnedItem.mockResolvedValue({ ...makeItemRow(), option: { meal: { dietProtocolId: PLAN_ID } } });
      requireAccessibleFood.mockResolvedValue(
        makeFood({ id: 'food-beef', name: 'Lean beef', proteinG: LEAN_BEEF_PROTEIN_PER_100G, energyKcal: 150 }),
      );

      await menu.addSubstitute(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, foodId: 'food-beef' });

      const { data } = prisma.dietItemSubstitute.create.mock.calls[0][0];
      expect(data).toMatchObject({
        dietFoodItemId: ITEM_ID,
        foodId: 'food-beef',
        name: 'Lean beef',
        householdMeasure: null,
        quantity: EQUIVALENT_LEAN_BEEF_QUANTITY,
        proteinPer100g: LEAN_BEEF_PROTEIN_PER_100G,
      });
      expectPlanMarked(prisma);
    });

    it('should reject a substitute without the swap nutrient', async () => {
      access.requireOwnedItem.mockResolvedValue({ ...makeItemRow(), option: { meal: { dietProtocolId: PLAN_ID } } });
      requireAccessibleFood.mockResolvedValue(makeFood({ proteinG: null }));

      const promise = menu.addSubstitute(prisma, { nutritionistId: NUTRITIONIST_ID, itemId: ITEM_ID, foodId: 'food-1' });

      await expect(promise).rejects.toMatchObject({ httpStatus: UNPROCESSABLE });
      expect(prisma.dietItemSubstitute.create).not.toHaveBeenCalled();
    });
  });

  describe('removeSubstitute', () => {
    it('should delete the substitute and flag the plan', async () => {
      access.requireOwnedSubstitute.mockResolvedValue({ id: SUBSTITUTE_ID, item: { option: { meal: { dietProtocolId: PLAN_ID } } } });

      await menu.removeSubstitute(prisma, { nutritionistId: NUTRITIONIST_ID, substituteId: SUBSTITUTE_ID });

      expect(prisma.dietItemSubstitute.delete).toHaveBeenCalledWith({ where: { id: SUBSTITUTE_ID } });
      expectPlanMarked(prisma);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  assertCanAddOption,
  buildOptionCopy,
  assertPublishable,
  recomputeSubstituteQuantities,
} from '../../src/helpers/nutrition-plan-rules.js';
import { AppError } from '../../src/errors/app-error.js';

const MAX_OPTIONS_CODE = 'nutrition.meal.maxOptions';
const NO_MEALS_CODE = 'nutrition.plan.noMeals';
const UNPROCESSABLE = 422;

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
const CHICKEN_PER_100G = { kcal: 159, protein: 32, carbs: 0, fat: 2.5, fiber: 0 };
const PATINHO_PER_100G = { kcal: 219, protein: 35.9, carbs: 0, fat: 7.3, fiber: 0 };

// Test helper: catch error.
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

// Test helper: make item.
function makeItem(overrides = {}) {
  return {
    id: 'item-1',
    foodId: 'food-chicken',
    name: 'Frango grelhado',
    source: 'taco',
    householdMeasure: '1 filé',
    quantity: 120,
    unit: 'g',
    per100g: CHICKEN_PER_100G,
    nutrients: { kcal: 190.8, protein: 38.4, carbs: 0, fat: 3, fiber: 0 },
    swapBasis: 'protein',
    order: 0,
    substitutes: [
      {
        id: 'sub-1',
        foodId: 'food-patinho',
        name: 'Patinho',
        source: 'tbca',
        householdMeasure: null,
        quantity: 106.96,
        per100g: PATINHO_PER_100G,
        nutrients: ZERO,
      },
    ],
    ...overrides,
  };
}

describe('assertCanAddOption', () => {
  it.each([[1], [2]])('should allow adding an option when the meal has %i option(s)', (count) => {
    const options = Array.from({ length: count }, (_, index) => ({ id: `o${index}`, position: index + 1 }));

    expect(() => assertCanAddOption(options)).not.toThrow();
  });

  it('should throw AppError 422 nutrition.meal.maxOptions when the meal already has 3 options', () => {
    const options = [{ position: 1 }, { position: 2 }, { position: 3 }];

    const error = catchError(() => assertCanAddOption(options));

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(UNPROCESSABLE);
    expect(error.messageCode).toBe(MAX_OPTIONS_CODE);
  });
});

describe('buildOptionCopy', () => {
  it('should copy every item of option 1 without ids', () => {
    const option1 = { id: 'opt-1', position: 1, items: [makeItem()] };

    const copy = buildOptionCopy(option1);

    expect(copy.items).toHaveLength(1);
    expect(copy.items[0]).toMatchObject({
      foodId: 'food-chicken',
      name: 'Frango grelhado',
      source: 'taco',
      householdMeasure: '1 filé',
      quantity: 120,
      unit: 'g',
      per100g: CHICKEN_PER_100G,
      swapBasis: 'protein',
    });
    expect(copy.items[0]).not.toHaveProperty('id');
  });

  it('should copy the substitutes of each item without ids', () => {
    const copy = buildOptionCopy({ id: 'opt-1', position: 1, items: [makeItem()] });

    expect(copy.items[0].substitutes).toHaveLength(1);
    expect(copy.items[0].substitutes[0]).toMatchObject({ foodId: 'food-patinho', quantity: 106.96 });
    expect(copy.items[0].substitutes[0]).not.toHaveProperty('id');
  });

  it('should return an empty item list when option 1 is empty', () => {
    expect(buildOptionCopy({ id: 'opt-1', position: 1, items: [] }).items).toEqual([]);
  });

  it('should not mutate the source option', () => {
    const option1 = { id: 'opt-1', position: 1, items: [makeItem()] };

    buildOptionCopy(option1);

    expect(option1.items[0].id).toBe('item-1');
  });
});

describe('assertPublishable', () => {
  const meal = { id: 'm1', options: [{ position: 1, items: [] }] };

  it('should accept a plan with a meal and a kcal target', () => {
    expect(() => assertPublishable({ goals: { kcalTarget: 2000 }, meals: [meal] })).not.toThrow();
  });

  it('should throw AppError 422 nutrition.plan.noMeals when there are no meals', () => {
    const error = catchError(() => assertPublishable({ goals: { kcalTarget: 2000 }, meals: [] }));

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(UNPROCESSABLE);
    expect(error.messageCode).toBe(NO_MEALS_CODE);
  });

  it('should accept meals when the kcal target is null', () => {
    expect(() => assertPublishable({ goals: { kcalTarget: null }, meals: [meal] })).not.toThrow();
  });

  it('should accept meals when goals are undefined', () => {
    expect(() => assertPublishable({ meals: [meal] })).not.toThrow();
  });

  it('should throw noMeals when there are no meals regardless of the kcal target', () => {
    const error = catchError(() => assertPublishable({ goals: { kcalTarget: null }, meals: [] }));

    expect(error.messageCode).toBe(NO_MEALS_CODE);
  });
});

describe('recomputeSubstituteQuantities', () => {
  it('should recompute substitute quantities by protein', () => {
    const item = makeItem();

    const [substitute] = recomputeSubstituteQuantities(item, 'protein');

    expect(substitute.quantity).toBeCloseTo(106.96, 2);
  });

  it('should recompute substitute quantities by kcal when the basis changes', () => {
    const item = makeItem();

    const [substitute] = recomputeSubstituteQuantities(item, 'kcal');

    expect(substitute.quantity).toBeCloseTo(87.12, 2);
  });

  it('should keep the substitute identity and only change the quantity', () => {
    const [substitute] = recomputeSubstituteQuantities(makeItem(), 'kcal');

    expect(substitute).toMatchObject({ id: 'sub-1', foodId: 'food-patinho' });
  });

  it('should return an empty list for an item without substitutes', () => {
    expect(recomputeSubstituteQuantities(makeItem({ substitutes: [] }), 'kcal')).toEqual([]);
  });
});

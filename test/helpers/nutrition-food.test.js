import { describe, it, expect } from 'vitest';
import { foodPer100g, foodPortion, defaultQuantity, toFoodDto, foodColumns } from '../../src/helpers/nutrition-food.js';
import { DEFAULT_FOOD_PORTION_GRAMS } from '../../src/constants/nutrition.js';

const SERVING_GRAMS = 50;
const SERVING_LABEL = '1 slice';

// Test helper: builds a Food row with every nutrient column set.
function makeFood(overrides = {}) {
  return {
    id: 'food-1',
    name: 'Bread',
    source: 'TACO',
    foodGroupId: 'group-1',
    foodGroup: { name: 'Cereals' },
    energyKcal: '250.5',
    proteinG: '9',
    carbohydratesG: '49',
    totalFatG: '3.2',
    fiberG: '2.7',
    servingSizeG: null,
    servingSizeDescription: null,
    ...overrides,
  };
}

describe('foodPer100g', () => {
  it('should convert decimal columns to numbers', () => {
    expect(foodPer100g(makeFood())).toEqual({ kcal: 250.5, protein: 9, carbs: 49, fat: 3.2, fiber: 2.7 });
  });

  it('should count null columns as 0', () => {
    const food = makeFood({ energyKcal: null, proteinG: null, carbohydratesG: null, totalFatG: null, fiberG: null });

    expect(foodPer100g(food)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  });
});

describe('foodPortion', () => {
  it('should return null when the food has no serving size', () => {
    expect(foodPortion(makeFood())).toBeNull();
  });

  it('should use the serving description as label', () => {
    const food = makeFood({ servingSizeG: String(SERVING_GRAMS), servingSizeDescription: SERVING_LABEL });

    expect(foodPortion(food)).toEqual({ label: SERVING_LABEL, grams: SERVING_GRAMS });
  });

  it('should fall back to "<grams> g" when there is no description', () => {
    const food = makeFood({ servingSizeG: SERVING_GRAMS });

    expect(foodPortion(food)).toEqual({ label: `${SERVING_GRAMS} g`, grams: SERVING_GRAMS });
  });
});

describe('defaultQuantity', () => {
  it('should return the serving grams when present', () => {
    expect(defaultQuantity(makeFood({ servingSizeG: SERVING_GRAMS }))).toBe(SERVING_GRAMS);
  });

  it('should fall back to the default portion when there is no serving size', () => {
    expect(defaultQuantity(makeFood())).toBe(DEFAULT_FOOD_PORTION_GRAMS);
  });
});

describe('toFoodDto', () => {
  it('should map a food with group, portion and nutrients', () => {
    const food = makeFood({ servingSizeG: SERVING_GRAMS, servingSizeDescription: SERVING_LABEL });

    expect(toFoodDto(food)).toEqual({
      id: 'food-1',
      name: 'Bread',
      source: 'TACO',
      groupId: 'group-1',
      groupName: 'Cereals',
      portion: { label: SERVING_LABEL, grams: SERVING_GRAMS },
      per100g: { kcal: 250.5, protein: 9, carbs: 49, fat: 3.2, fiber: 2.7 },
    });
  });

  it('should return a null group name and portion when absent', () => {
    const dto = toFoodDto(makeFood({ foodGroup: null }));

    expect(dto.groupName).toBeNull();
    expect(dto.portion).toBeNull();
  });
});

describe('foodColumns', () => {
  const per100g = { kcal: 100, protein: 10, carbs: 20, fat: 5, fiber: 3 };
  const portion = { label: SERVING_LABEL, grams: SERVING_GRAMS };

  it('should return an empty object when nothing is provided', () => {
    expect(foodColumns({})).toEqual({});
  });

  it('should map only nutrient columns when there is no portion', () => {
    expect(foodColumns({ per100g })).toEqual({
      energyKcal: 100,
      proteinG: 10,
      carbohydratesG: 20,
      fiberG: 3,
      totalFatG: 5,
    });
  });

  it('should map only serving columns when there are no nutrients', () => {
    expect(foodColumns({ portion })).toEqual({ servingSizeG: SERVING_GRAMS, servingSizeDescription: SERVING_LABEL });
  });

  it('should map both groups when both are provided', () => {
    expect(Object.keys(foodColumns({ per100g, portion }))).toHaveLength(7);
  });
});

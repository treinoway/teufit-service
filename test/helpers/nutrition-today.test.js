import { describe, it, expect } from 'vitest';
import { buildToday, clampWater, assertSwapAllowed } from '../../src/helpers/nutrition-today.js';
import { AppError } from '../../src/errors/app-error.js';

const DATE = '2026-11-02';
const CUP_ML = 250;
const WATER_TARGET_ML = 2000;
const SWAP_NOT_ALLOWED_CODE = 'nutrition.swap.notAllowed';
const PLAN_NOT_FOUND_CODE = 'nutrition.plan.notFound';
const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
const DONE_AT = new Date('2026-11-02T10:30:00.000Z');

// Test helper: make item.
function makeItem(id, substitutes = []) {
  return {
    id,
    foodId: `food-${id}`,
    name: `Item ${id}`,
    source: 'taco',
    householdMeasure: '1 porção',
    quantity: 100,
    unit: 'g',
    per100g: ZERO,
    nutrients: ZERO,
    swapBasis: 'protein',
    order: 0,
    substitutes,
  };
}

// Test helper: make substitute.
function makeSubstitute(id) {
  return { id, foodId: `food-${id}`, name: `Sub ${id}`, source: 'tbca', householdMeasure: null, quantity: 90, nutrients: ZERO };
}

// Test helper: make meal.
function makeMeal(id, order, time, items = [makeItem(`${id}-i1`)]) {
  return {
    id,
    name: `Refeição ${id}`,
    time,
    order,
    tip: null,
    options: [
      { id: `${id}-o1`, position: 1, items, totals: ZERO },
      { id: `${id}-o2`, position: 2, items, totals: ZERO },
    ],
  };
}

// Test helper: make snapshot.
function makeSnapshot(overrides = {}) {
  return {
    id: 'plan-1',
    version: 2,
    nutritionist: { firstName: 'Ana', lastName: 'Nutri', avatarUrl: null },
    guidance: {
      waterTargetMl: WATER_TARGET_ML,
      freeMealsPerWeek: 0,
      freeMealText: null,
      supplements: [],
      observations: null,
      patientMessage: 'Bom dia!',
    },
    meals: [makeMeal('m1', 0, '07:00'), makeMeal('m2', 1, '12:00')],
    ...overrides,
  };
}

// Test helper: build.
function build(overrides = {}) {
  return buildToday({ date: DATE, snapshot: makeSnapshot(), mealLogs: [], swapLogs: [], waterMl: 0, ...overrides });
}

// Test helper: catch error.
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe('buildToday', () => {
  it('should return plan null when there is no published snapshot', () => {
    expect(build({ snapshot: null })).toEqual({ date: DATE, plan: null });
  });

  it('should echo the date, plan id/version, nutritionist and patient message', () => {
    const today = build();

    expect(today.date).toBe(DATE);
    expect(today.plan).toMatchObject({
      id: 'plan-1',
      version: 2,
      nutritionist: { firstName: 'Ana', lastName: 'Nutri', avatarUrl: null },
      patientMessage: 'Bom dia!',
    });
  });

  it('should mark every meal pending with option 1 selected by default', () => {
    const { meals } = build().plan;

    expect(meals[0]).toMatchObject({ status: 'pending', doneAt: null, note: null, selectedOptionId: 'm1-o1' });
  });

  it('should pick the next meal as the first pending meal by order', () => {
    const plan = build({ mealLogs: [{ mealId: 'm1', optionId: null, status: 'done', doneAt: DONE_AT, note: null }] }).plan;

    expect(plan.nextMealId).toBe('m2');
  });

  it('should have a null next meal when every meal is resolved', () => {
    const logs = [
      { mealId: 'm1', optionId: null, status: 'done', doneAt: DONE_AT, note: null },
      { mealId: 'm2', optionId: null, status: 'different', doneAt: DONE_AT, note: 'pizza' },
    ];

    expect(build({ mealLogs: logs }).plan.nextMealId).toBeNull();
  });

  it('should count done meals and total meals', () => {
    const plan = build({ mealLogs: [{ mealId: 'm1', optionId: null, status: 'done', doneAt: DONE_AT, note: null }] }).plan;

    expect(plan).toMatchObject({ mealsDone: 1, mealsTotal: 2 });
  });

  it('should expose the logged status, doneAt and note of a meal', () => {
    const logs = [{ mealId: 'm2', optionId: null, status: 'different', doneAt: DONE_AT, note: 'pizza' }];

    const meal = build({ mealLogs: logs }).plan.meals[1];

    expect(meal).toMatchObject({ status: 'different', note: 'pizza' });
    expect(new Date(meal.doneAt).toISOString()).toBe(DONE_AT.toISOString());
  });

  it('should use the option chosen for the day', () => {
    const logs = [{ mealId: 'm1', optionId: 'm1-o2', status: null, doneAt: null, note: null }];

    const meal = build({ mealLogs: logs }).plan.meals[0];

    expect(meal.selectedOptionId).toBe('m1-o2');
    expect(meal.status).toBe('pending');
  });

  it('should keep selecting option 1 when the logged option no longer exists in the snapshot', () => {
    const logs = [{ mealId: 'm1', optionId: 'gone', status: null, doneAt: null, note: null }];

    expect(build({ mealLogs: logs }).plan.meals[0].selectedOptionId).toBe('m1-o1');
  });

  it('should ignore logs of meals that are not in the snapshot', () => {
    const logs = [{ mealId: 'orphan', optionId: null, status: 'done', doneAt: DONE_AT, note: null }];

    expect(build({ mealLogs: logs }).plan.mealsDone).toBe(0);
  });

  it('should sort meals by order', () => {
    const snapshot = makeSnapshot({ meals: [makeMeal('late', 1, '12:00'), makeMeal('early', 0, '07:00')] });

    expect(build({ snapshot }).plan.meals.map((meal) => meal.id)).toEqual(['early', 'late']);
  });

  it('should set canSwap only for items with substitutes', () => {
    const snapshot = makeSnapshot({
      meals: [makeMeal('m1', 0, '07:00', [makeItem('with', [makeSubstitute('s1')]), makeItem('without')])],
    });

    const [withSubs, withoutSubs] = build({ snapshot }).plan.meals[0].options[0].items;

    expect(withSubs.canSwap).toBe(true);
    expect(withoutSubs.canSwap).toBe(false);
  });

  it('should apply the swap of the day to the item', () => {
    const snapshot = makeSnapshot({ meals: [makeMeal('m1', 0, '07:00', [makeItem('i1', [makeSubstitute('s1')])])] });

    const item = build({ snapshot, swapLogs: [{ itemId: 'i1', substituteId: 's1' }] }).plan.meals[0].options[0].items[0];

    expect(item.swappedTo).toMatchObject({ substituteId: 's1', name: 'Sub s1', quantity: 90 });
  });

  it('should leave swappedTo null without a swap log', () => {
    const snapshot = makeSnapshot({ meals: [makeMeal('m1', 0, '07:00', [makeItem('i1', [makeSubstitute('s1')])])] });

    expect(build({ snapshot }).plan.meals[0].options[0].items[0].swappedTo).toBeNull();
  });

  it('should report water target, consumed and cup size', () => {
    expect(build({ waterMl: 750 }).plan.water).toEqual({ targetMl: WATER_TARGET_ML, consumedMl: 750, cupMl: CUP_ML });
  });

  it('should return freeMeal null when no free meals are allowed', () => {
    expect(build().plan.freeMeal).toBeNull();
  });

  it('should return freeMeal with perWeek and text when allowed', () => {
    const base = makeSnapshot();
    const snapshot = makeSnapshot({ guidance: { ...base.guidance, freeMealsPerWeek: 2, freeMealText: 'Sem exagero' } });

    expect(build({ snapshot }).plan.freeMeal).toEqual({ perWeek: 2, text: 'Sem exagero' });
  });
});

describe('clampWater', () => {
  it('should add the delta to the current total', () => {
    expect(clampWater(500, CUP_ML, WATER_TARGET_ML)).toBe(750);
  });

  it('should allow undoing with a negative delta', () => {
    expect(clampWater(500, -CUP_ML, WATER_TARGET_ML)).toBe(250);
  });

  it('should never go below 0', () => {
    expect(clampWater(100, -500, WATER_TARGET_ML)).toBe(0);
  });

  it('should cap the total at 2x the target', () => {
    expect(clampWater(3900, 500, WATER_TARGET_ML)).toBe(2 * WATER_TARGET_ML);
  });

  it('should accept exactly 2x the target', () => {
    expect(clampWater(3750, CUP_ML, WATER_TARGET_ML)).toBe(2 * WATER_TARGET_ML);
  });
});

describe('assertSwapAllowed', () => {
  const snapshot = makeSnapshot({
    meals: [makeMeal('m1', 0, '07:00', [makeItem('i1', [makeSubstitute('s1')]), makeItem('i2')])],
  });

  it('should accept a substitute released for the item', () => {
    expect(() => assertSwapAllowed(snapshot, 'i1', 's1')).not.toThrow();
  });

  it('should throw AppError 422 nutrition.swap.notAllowed for a substitute not released for the item', () => {
    const error = catchError(() => assertSwapAllowed(snapshot, 'i1', 'other-sub'));

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(422);
    expect(error.messageCode).toBe(SWAP_NOT_ALLOWED_CODE);
  });

  it('should throw 422 nutrition.swap.notAllowed for an item without substitutes', () => {
    const error = catchError(() => assertSwapAllowed(snapshot, 'i2', 's1'));

    expect(error.httpStatus).toBe(422);
    expect(error.messageCode).toBe(SWAP_NOT_ALLOWED_CODE);
  });

  it('should throw AppError 404 nutrition.plan.notFound for an item that is not in the snapshot', () => {
    const error = catchError(() => assertSwapAllowed(snapshot, 'missing', 's1'));

    expect(error.httpStatus).toBe(404);
    expect(error.messageCode).toBe(PLAN_NOT_FOUND_CODE);
  });
});

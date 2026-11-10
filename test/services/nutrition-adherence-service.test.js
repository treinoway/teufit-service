import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAdherenceByPatient, emptyAdherence } from '../../src/services/nutrition-adherence-service.js';
import { MealLogStatus, PlanStatus } from '../../src/constants/nutrition.js';

const NOW = new Date('2026-11-02T15:00:00.000Z');
const WINDOW_DAYS = 7;
const MEALS_PER_PLAN = 2;
const LONG_AGO = new Date('2026-09-01T12:00:00.000Z');
const TWO_DAYS_AGO = new Date('2026-11-01T12:00:00.000Z');
const TODAY_KEY = new Date('2026-11-02T00:00:00.000Z');
const BEFORE_FIRST_DAY_KEY = new Date('2026-10-30T00:00:00.000Z');
const FAR_FUTURE_KEY = new Date('2026-11-09T00:00:00.000Z');

// Test helper: build a snapshot item with substitutes.
function makeItem(id, name, substitutes = []) {
  return { id, name, substitutes };
}

// Test helper: build a snapshot with two meals, the first carrying a swappable item.
function makeSnapshot() {
  const bread = makeItem('item-bread', 'Pão', [{ id: 'sub-toast', name: 'Torrada' }, { id: 'sub-cake', name: 'Bolo' }]);
  return {
    meals: [
      { id: 'meal-breakfast', name: 'Café', options: [{ id: 'o1', items: [bread] }] },
      { id: 'meal-lunch', name: 'Almoço', options: [{ id: 'o2', items: [makeItem('item-rice', 'Arroz')] }] },
    ],
  };
}

// Test helper: build a plan row.
function makePlan(overrides = {}) {
  return {
    id: 'plan-1',
    assigneeId: 'patient-1',
    status: PlanStatus.PUBLISHED,
    firstPublishedAt: LONG_AGO,
    publishedSnapshot: makeSnapshot(),
    ...overrides,
  };
}

// Test helper: build a meal log row.
function makeMealLog(mealId, status = MealLogStatus.DONE, planId = 'plan-1', date = TODAY_KEY) {
  return { planId, mealId, status, date };
}

// Test helper: build a swap log row.
function makeSwapLog(itemId, substituteId, planId = 'plan-1', date = TODAY_KEY) {
  return { planId, itemId, substituteId, date };
}

// Test helper: build a mocked prisma client returning the given logs.
function makePrisma({ mealLogs = [], swapLogs = [] } = {}) {
  return {
    dietMealLog: { findMany: vi.fn().mockResolvedValue(mealLogs) },
    dietSwapLog: { findMany: vi.fn().mockResolvedValue(swapLogs) },
  };
}

describe('loadAdherenceByPatient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return an empty map without querying when there are no published plans', async () => {
    const prisma = makePrisma();

    const result = await loadAdherenceByPatient(prisma, [makePlan({ status: PlanStatus.DRAFT })]);

    expect(result.size).toBe(0);
    expect(prisma.dietMealLog.findMany).not.toHaveBeenCalled();
  });

  it('should ignore plans without a published snapshot', async () => {
    const result = await loadAdherenceByPatient(makePrisma(), [makePlan({ publishedSnapshot: null })]);

    expect(result.size).toBe(0);
  });

  it('should ignore draft plans and keep the published ones', async () => {
    const plans = [makePlan(), makePlan({ id: 'plan-2', assigneeId: 'patient-2', status: PlanStatus.DRAFT })];

    const result = await loadAdherenceByPatient(makePrisma(), plans);

    expect([...result.keys()]).toEqual(['patient-1']);
  });

  it('should query only the ids of published plans inside the window', async () => {
    const prisma = makePrisma();

    await loadAdherenceByPatient(prisma, [makePlan(), makePlan({ id: 'plan-2', assigneeId: 'p2', status: PlanStatus.DRAFT })]);

    expect(prisma.dietMealLog.findMany).toHaveBeenCalledWith({
      where: { planId: { in: ['plan-1'] }, date: { gte: new Date('2026-10-27T00:00:00.000Z'), lte: new Date('2026-11-03T00:00:00.000Z') }, status: { not: null } },
    });
  });

  it('should count only done meals of the snapshot', async () => {
    const mealLogs = [
      makeMealLog('meal-breakfast', MealLogStatus.DONE),
      makeMealLog('meal-lunch', MealLogStatus.DIFFERENT),
      makeMealLog('meal-removed', MealLogStatus.DONE),
    ];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan()]);

    expect(result.get('patient-1').mealsDone).toBe(1);
  });

  it('should expect all meals for every day of the window for an old plan', async () => {
    const result = await loadAdherenceByPatient(makePrisma(), [makePlan()]);

    expect(result.get('patient-1').mealsExpected).toBe(MEALS_PER_PLAN * WINDOW_DAYS);
  });

  it('should expect meals only for the days since the plan was first published', async () => {
    const result = await loadAdherenceByPatient(makePrisma(), [makePlan({ firstPublishedAt: TWO_DAYS_AGO })]);

    expect(result.get('patient-1').mealsExpected).toBe(MEALS_PER_PLAN * 2);
  });

  it('should treat a plan without firstPublishedAt as published today', async () => {
    const result = await loadAdherenceByPatient(makePrisma(), [makePlan({ firstPublishedAt: null })]);

    expect(result.get('patient-1').mealsExpected).toBe(MEALS_PER_PLAN);
  });

  it('should ignore logs dated before the plan was first published', async () => {
    const mealLogs = [makeMealLog('meal-breakfast', MealLogStatus.DONE, 'plan-1', BEFORE_FIRST_DAY_KEY)];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan({ firstPublishedAt: TWO_DAYS_AGO })]);

    expect(result.get('patient-1').mealsDone).toBe(0);
  });

  it('should ignore logs dated after tomorrow', async () => {
    const mealLogs = [makeMealLog('meal-breakfast', MealLogStatus.DONE, 'plan-1', FAR_FUTURE_KEY)];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan()]);

    expect(result.get('patient-1').mealsDone).toBe(0);
  });

  it('should compute the rounded percent of done over expected meals', async () => {
    const mealLogs = [makeMealLog('meal-breakfast'), makeMealLog('meal-lunch'), makeMealLog('meal-breakfast')];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan()]);

    expect(result.get('patient-1').percent).toBe(Math.round((3 / (MEALS_PER_PLAN * WINDOW_DAYS)) * 100));
  });

  it('should cap the percent at 100', async () => {
    const mealLogs = Array.from({ length: 5 }, () => makeMealLog('meal-breakfast'));

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan({ firstPublishedAt: NOW })]);

    expect(result.get('patient-1').percent).toBe(100);
  });

  it('should return the most requested swap pair with the snapshot names', async () => {
    const swapLogs = [
      makeSwapLog('item-bread', 'sub-cake'),
      makeSwapLog('item-bread', 'sub-toast'),
      makeSwapLog('item-bread', 'sub-toast'),
    ];

    const result = await loadAdherenceByPatient(makePrisma({ swapLogs }), [makePlan()]);

    expect(result.get('patient-1').swaps).toEqual({ total: 3, topPair: { from: 'Pão', to: 'Torrada' } });
  });

  it('should ignore orphan swap logs whose item or substitute left the snapshot', async () => {
    const swapLogs = [makeSwapLog('item-gone', 'sub-toast'), makeSwapLog('item-bread', 'sub-gone')];

    const result = await loadAdherenceByPatient(makePrisma({ swapLogs }), [makePlan()]);

    expect(result.get('patient-1').swaps).toEqual({ total: 0, topPair: null });
  });

  it('should return the meal where the patient ate differently most often', async () => {
    const mealLogs = [
      makeMealLog('meal-breakfast', MealLogStatus.DIFFERENT),
      makeMealLog('meal-lunch', MealLogStatus.DIFFERENT),
      makeMealLog('meal-lunch', MealLogStatus.DIFFERENT),
    ];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan()]);

    expect(result.get('patient-1').ateDifferent).toEqual({ total: 3, topMealName: 'Almoço' });
  });

  it('should ignore orphan different logs of meals no longer in the snapshot', async () => {
    const mealLogs = [makeMealLog('meal-gone', MealLogStatus.DIFFERENT)];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), [makePlan()]);

    expect(result.get('patient-1').ateDifferent).toEqual({ total: 0, topMealName: null });
  });

  it('should keep the logs of each plan separated per patient', async () => {
    const plans = [makePlan(), makePlan({ id: 'plan-2', assigneeId: 'patient-2' })];
    const mealLogs = [makeMealLog('meal-breakfast', MealLogStatus.DONE, 'plan-2')];

    const result = await loadAdherenceByPatient(makePrisma({ mealLogs }), plans);

    expect(result.get('patient-1').mealsDone).toBe(0);
    expect(result.get('patient-2').mealsDone).toBe(1);
  });
});

describe('emptyAdherence', () => {
  it('should return zeroed adherence', () => {
    expect(emptyAdherence()).toEqual({
      mealsDone: 0,
      mealsExpected: 0,
      percent: 0,
      swaps: { total: 0, topPair: null },
      ateDifferent: { total: 0, topMealName: null },
    });
  });
});

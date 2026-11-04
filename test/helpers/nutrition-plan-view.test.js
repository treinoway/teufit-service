import { describe, it, expect } from 'vitest';
import { buildPlanView, buildSnapshot, hasPendingChanges } from '../../src/helpers/nutrition-plan-view.js';
import { BmrFormula, Objective, PlanStatus, Sex, GoalStatus } from '../../src/constants/nutrition.js';

const REFERENCE_BMR = 1385.25;
const REFERENCE_TEE = 1904.72;
const ACTIVITY_FACTOR = 1.375;
const PUBLISHED_AT = new Date('2026-10-20T12:00:00.000Z');

const REFERENCE_SHEET = Object.freeze({
  sex: Sex.FEMALE,
  age: 29,
  weightKg: 66,
  heightCm: 165,
  bodyFatPct: 28,
});

// Test helper: build a plan row with an empty meals tree.
function makePlanRow(overrides = {}) {
  return {
    id: 'plan-1',
    assigneeId: 'patient-1',
    status: PlanStatus.DRAFT,
    version: 1,
    publishedAt: null,
    hasUnpublishedChanges: true,
    bmrFormula: BmrFormula.MIFFLIN,
    activityFactor: ACTIVITY_FACTOR,
    activities: [],
    objective: Objective.MAINTAIN,
    kcalTarget: null,
    proteinPerKg: null,
    fatPerKg: null,
    carbPerKg: null,
    carbIsRemainder: false,
    fiberMinG: null,
    waterTargetMl: 2000,
    freeMealsPerWeek: 1,
    freeMealText: 'Pizza',
    supplements: [],
    observations: null,
    patientMessage: 'Oi',
    meals: [],
    ...overrides,
  };
}

// Test helper: build a meal row with a single option and item (100 g, 200 kcal per 100 g).
function makeMealRow(overrides = {}) {
  return {
    id: 'meal-1',
    name: 'Café',
    time: '07:00',
    order: 0,
    tip: null,
    options: [
      {
        id: 'opt-1',
        position: 1,
        items: [
          {
            id: 'item-1',
            foodId: 'food-1',
            name: 'Pão',
            source: 'taco',
            householdMeasure: null,
            quantity: 100,
            unit: 'g',
            kcalPer100g: 200,
            proteinPer100g: 10,
            carbsPer100g: 30,
            fatPer100g: 5,
            fiberPer100g: 2,
            swapBasis: 'protein',
            order: 0,
            substitutes: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('buildPlanView computed energy', () => {
  it('should compute the Mifflin BMR for the reference sheet', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    expect(view.computed.bmr).toBe(REFERENCE_BMR);
  });

  it('should compute the TEE with the activity factor', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    expect(view.computed.tee).toBe(REFERENCE_TEE);
  });

  it('should suggest the TEE for the maintain objective', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    expect(view.computed.suggestedKcal).toBe(REFERENCE_TEE);
  });

  it('should reduce the suggested kcal for a deficit objective', () => {
    const view = buildPlanView(makePlanRow({ objective: Objective.DEFICIT_10 }), REFERENCE_SHEET);

    expect(view.computed.suggestedKcal).toBeCloseTo(REFERENCE_TEE * 0.9, 2);
  });

  it('should return null energy values when the sheet is incomplete', () => {
    const view = buildPlanView(makePlanRow(), { ...REFERENCE_SHEET, heightCm: null });

    expect(view.computed).toMatchObject({ bmr: null, tee: null, suggestedKcal: null });
  });
});

describe('buildPlanView computed macros and day status', () => {
  it('should return null macros without a kcal target', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    expect(view.computed.macros).toBeNull();
  });

  it('should return null macros without a weight', () => {
    const view = buildPlanView(makePlanRow({ kcalTarget: 2000 }), { ...REFERENCE_SHEET, weightKg: null });

    expect(view.computed.macros).toBeNull();
  });

  it('should compute macro targets from the g/kg values', () => {
    const row = makePlanRow({ kcalTarget: 2000, proteinPerKg: 2, fatPerKg: 1, carbPerKg: 3 });

    const view = buildPlanView(row, REFERENCE_SHEET);

    expect(view.computed.macros.protein.grams).toBe(132);
    expect(view.computed.macros.fat.grams).toBe(66);
  });

  it('should leave every day status null when there are no goals', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    expect(view.computed.dayStatus).toEqual({ kcal: null, protein: null, carbs: null, fat: null, fiber: null });
  });

  it('should leave the status null for macros without their own goal even when a kcal target exists', () => {
    const row = makePlanRow({ kcalTarget: 2000, proteinPerKg: 2, meals: [makeMealRow()] });

    const view = buildPlanView(row, REFERENCE_SHEET);

    expect(view.computed.dayStatus).toMatchObject({ kcal: GoalStatus.LOW, fat: null, carbs: null, fiber: null });
    expect(view.computed.dayStatus.protein).not.toBeNull();
  });

  it('should give carbs a status when they close the calories (carbIsRemainder) and null otherwise', () => {
    const base = { kcalTarget: 2000, proteinPerKg: 2, fatPerKg: 1, meals: [makeMealRow()] };

    const remainder = buildPlanView(makePlanRow({ ...base, carbIsRemainder: true }), REFERENCE_SHEET);
    const noCarbGoal = buildPlanView(makePlanRow(base), REFERENCE_SHEET);

    expect(remainder.computed.dayStatus.carbs).not.toBeNull();
    expect(noCarbGoal.computed.dayStatus.carbs).toBeNull();
  });

  it('should sum the day totals of the meals', () => {
    const view = buildPlanView(makePlanRow({ meals: [makeMealRow()] }), REFERENCE_SHEET);

    expect(view.computed.dayTotals.kcal).toBe(200);
  });

  it('should flag the kcal as low when the day is under the target', () => {
    const view = buildPlanView(makePlanRow({ kcalTarget: 2000, meals: [makeMealRow()] }), REFERENCE_SHEET);

    expect(view.computed.dayStatus.kcal).toBe(GoalStatus.LOW);
  });

  it('should treat the fiber goal as a minimum', () => {
    const view = buildPlanView(makePlanRow({ fiberMinG: 1, meals: [makeMealRow()] }), REFERENCE_SHEET);

    expect(view.computed.dayStatus.fiber).toBe(GoalStatus.OK);
  });
});

describe('hasPendingChanges', () => {
  it('should be false for a draft even with unpublished changes', () => {
    expect(hasPendingChanges(makePlanRow({ status: PlanStatus.DRAFT, hasUnpublishedChanges: true }))).toBe(false);
  });

  it('should be true for a published plan with unpublished changes', () => {
    expect(hasPendingChanges(makePlanRow({ status: PlanStatus.PUBLISHED, hasUnpublishedChanges: true }))).toBe(true);
  });

  it('should be false for a published plan without unpublished changes', () => {
    expect(hasPendingChanges(makePlanRow({ status: PlanStatus.PUBLISHED, hasUnpublishedChanges: false }))).toBe(false);
  });
});

describe('buildPlanView shape', () => {
  it('should map identity, status and publish date', () => {
    const view = buildPlanView(makePlanRow({ status: PlanStatus.PUBLISHED, version: 3, publishedAt: PUBLISHED_AT }), REFERENCE_SHEET);

    expect(view).toMatchObject({
      id: 'plan-1',
      patientId: 'patient-1',
      status: PlanStatus.PUBLISHED,
      version: 3,
      publishedAt: PUBLISHED_AT.toISOString(),
      hasUnpublishedChanges: true,
    });
  });

  it('should return a null publishedAt for a draft', () => {
    expect(buildPlanView(makePlanRow(), REFERENCE_SHEET).publishedAt).toBeNull();
  });

  it('should convert goal decimals to numbers', () => {
    const view = buildPlanView(makePlanRow({ activityFactor: '1.375', proteinPerKg: '1.8' }), REFERENCE_SHEET);

    expect(view.goals).toMatchObject({ activityFactor: 1.375, proteinPerKg: 1.8, bmrFormula: BmrFormula.MIFFLIN });
  });

  it('should sort meals by order', () => {
    const meals = [makeMealRow({ id: 'late', order: 2 }), makeMealRow({ id: 'early', order: 1 })];

    const view = buildPlanView(makePlanRow({ meals }), REFERENCE_SHEET);

    expect(view.meals.map((meal) => meal.id)).toEqual(['early', 'late']);
  });

  it('should compute item nutrients from the quantity and per 100 g values', () => {
    const view = buildPlanView(makePlanRow({ meals: [makeMealRow()] }), REFERENCE_SHEET);

    expect(view.meals[0].options[0].items[0].nutrients.kcal).toBe(200);
  });
});

describe('buildSnapshot', () => {
  const nutritionist = { firstName: 'Ana', lastName: 'Nutri', avatarUrl: 'avatars/ana.png', email: 'secret@x.com' };

  it('should expose only id, version, nutritionist identity, guidance and meals', () => {
    const view = buildPlanView(makePlanRow({ version: 4, meals: [makeMealRow()] }), REFERENCE_SHEET);

    const snapshot = buildSnapshot(view, nutritionist);

    expect(snapshot).toEqual({
      id: 'plan-1',
      version: 4,
      nutritionist: { firstName: 'Ana', lastName: 'Nutri', avatarUrl: 'avatars/ana.png' },
      guidance: view.guidance,
      meals: view.meals,
    });
  });

  it('should default missing nutritionist fields to null', () => {
    const view = buildPlanView(makePlanRow(), REFERENCE_SHEET);

    const snapshot = buildSnapshot(view, {});

    expect(snapshot.nutritionist).toEqual({ firstName: null, lastName: null, avatarUrl: null });
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeBmr,
  activityKcalPerDay,
  computeTee,
  suggestTarget,
  macroTargets,
  itemNutrients,
  mealTotals,
  dayTotals,
  goalStatus,
  equivalentQuantity,
} from '../../src/helpers/nutrition-calc.js';

const BmrFormula = Object.freeze({
  MIFFLIN: 'mifflin',
  HARRIS_BENEDICT: 'harris_benedict',
  FAO_WHO: 'fao_who',
  KATCH_MCARDLE: 'katch_mcardle',
});
const Objective = Object.freeze({
  MAINTAIN: 'maintain',
  DEFICIT_10: 'deficit_10',
  DEFICIT_20: 'deficit_20',
  SURPLUS_10: 'surplus_10',
});
const Basis = Object.freeze({ PROTEIN: 'protein', KCAL: 'kcal' });
const GoalStatus = Object.freeze({ OK: 'ok', LOW: 'low', HIGH: 'high' });

const SHEET = Object.freeze({ sex: 'female', age: 29, weightKg: 66, heightCm: 165, bodyFatPct: 28 });
const ACTIVITY_FACTOR = 1.375;

const CHICKEN_PER_100G = Object.freeze({ kcal: 159, protein: 32, carbs: 0, fat: 2.5, fiber: 0 });
const PATINHO_PER_100G = Object.freeze({ kcal: 219, protein: 35.9, carbs: 0, fat: 7.3, fiber: 0 });

describe('computeBmr', () => {
  it.each([
    [BmrFormula.MIFFLIN, 1385.25],
    [BmrFormula.HARRIS_BENEDICT, 1443.5],
    [BmrFormula.FAO_WHO, 1466.2],
    [BmrFormula.KATCH_MCARDLE, 1396.43],
  ])('should compute %s for the reference sheet (female, 29y, 66kg, 165cm, 28%% fat) as %f', (bmrFormula, expected) => {
    expect(computeBmr({ bmrFormula }, SHEET)).toBeCloseTo(expected, 1);
  });

  it('should return Mifflin to the exact 2-decimal reference value', () => {
    expect(computeBmr({ bmrFormula: BmrFormula.MIFFLIN }, SHEET)).toBe(1385.25);
  });

  it('should use lean mass (weight x (1 - bodyFat)) for Katch-McArdle', () => {
    const heavier = { ...SHEET, weightKg: 80, bodyFatPct: 25 };

    expect(computeBmr({ bmrFormula: BmrFormula.KATCH_MCARDLE }, heavier)).toBeCloseTo(1666, 1);
  });

  it('should apply the male constant for Mifflin', () => {
    const male = { ...SHEET, sex: 'male' };

    expect(computeBmr({ bmrFormula: BmrFormula.MIFFLIN }, male)).toBe(1551.25);
  });

  it('should not depend on body fat for non-Katch formulas', () => {
    const withoutFat = { ...SHEET, bodyFatPct: null };

    expect(computeBmr({ bmrFormula: BmrFormula.MIFFLIN }, withoutFat)).toBe(1385.25);
  });

  it('should return null for Katch-McArdle when body fat is missing', () => {
    const withoutFat = { ...SHEET, bodyFatPct: null };

    expect(computeBmr({ bmrFormula: BmrFormula.KATCH_MCARDLE }, withoutFat)).toBeNull();
  });
});

describe('activityKcalPerDay', () => {
  it('should compute MET x kg x hours x perWeek / 7 (5.0 MET, 60 min, 4x/week, 66 kg)', () => {
    expect(activityKcalPerDay({ met: 5, minutes: 60, perWeek: 4 }, 66)).toBe(188.57);
  });

  it('should scale with minutes', () => {
    expect(activityKcalPerDay({ met: 5, minutes: 30, perWeek: 7 }, 70)).toBe(175);
  });

  it('should return 0 when the activity never happens in the week', () => {
    expect(activityKcalPerDay({ met: 5, minutes: 60, perWeek: 0 }, 66)).toBe(0);
  });
});

describe('computeTee', () => {
  const activity = { name: 'Musculação', met: 5, minutes: 60, perWeek: 4, included: true, fromTraining: true };

  it('should return BMR x factor when there are no activities', () => {
    expect(computeTee({ bmr: 1385.25, factor: ACTIVITY_FACTOR, activities: [], weightKg: 66 })).toBe(1904.72);
  });

  it('should add the kcal/day of every included activity', () => {
    expect(computeTee({ bmr: 1385.25, factor: ACTIVITY_FACTOR, activities: [activity], weightKg: 66 })).toBe(2093.29);
  });

  it('should ignore activities flagged included=false', () => {
    const excluded = { ...activity, included: false };

    expect(computeTee({ bmr: 1385.25, factor: ACTIVITY_FACTOR, activities: [excluded], weightKg: 66 })).toBe(1904.72);
  });

  it('should sum several included activities', () => {
    const walk = { name: 'Caminhada', met: 3.5, minutes: 30, perWeek: 7, included: true, fromTraining: false };

    expect(computeTee({ bmr: 1385.25, factor: ACTIVITY_FACTOR, activities: [activity, walk], weightKg: 66 })).toBe(2208.79);
  });
});

describe('suggestTarget', () => {
  it.each([
    [Objective.MAINTAIN, 2000],
    [Objective.DEFICIT_10, 1800],
    [Objective.DEFICIT_20, 1600],
    [Objective.SURPLUS_10, 2200],
  ])('should apply objective %s to a 2000 kcal TEE giving %f', (objective, expected) => {
    expect(suggestTarget(2000, objective)).toBe(expected);
  });

  it('should round to 2 decimals', () => {
    expect(suggestTarget(2093.29, Objective.DEFICIT_10)).toBe(1883.96);
  });
});

describe('macroTargets', () => {
  const baseInput = { kcal: 2000, proteinPerKg: 2, fatPerKg: 1, carbPerKg: null, carbIsRemainder: false, fiberMinG: 25 };
  const WEIGHT_KG = 66;

  it('should convert g/kg into grams, kcal and %VET for protein and fat', () => {
    const macros = macroTargets({ ...baseInput, carbPerKg: 3 }, WEIGHT_KG);

    expect(macros.protein).toEqual({ grams: 132, kcal: 528, pct: 26.4 });
    expect(macros.fat).toEqual({ grams: 66, kcal: 594, pct: 29.7 });
  });

  it('should use carbPerKg when carbIsRemainder is false', () => {
    const macros = macroTargets({ ...baseInput, carbPerKg: 3 }, WEIGHT_KG);

    expect(macros.carbs).toEqual({ grams: 198, kcal: 792, pct: 39.6 });
  });

  it('should report diffKcal as macros total minus the target (negative = below)', () => {
    const macros = macroTargets({ ...baseInput, carbPerKg: 3 }, WEIGHT_KG);

    expect(macros.totalKcal).toBe(1914);
    expect(macros.diffKcal).toBe(-86);
  });

  it('should make carbs close the calories when carbIsRemainder is true', () => {
    const macros = macroTargets({ ...baseInput, carbIsRemainder: true }, WEIGHT_KG);

    expect(macros.carbs).toEqual({ grams: 219.5, kcal: 878, pct: 43.9 });
    expect(macros.totalKcal).toBe(2000);
    expect(macros.diffKcal).toBe(0);
  });

  it('should ignore carbPerKg when carbIsRemainder is true', () => {
    const macros = macroTargets({ ...baseInput, carbPerKg: 9, carbIsRemainder: true }, WEIGHT_KG);

    expect(macros.carbs.kcal).toBe(878);
  });

  it('should floor remainder carbs at 0 g when protein and fat already pass the target', () => {
    const macros = macroTargets(
      { ...baseInput, proteinPerKg: 3, fatPerKg: 2.5, carbIsRemainder: true },
      WEIGHT_KG,
    );

    expect(macros.carbs).toEqual({ grams: 0, kcal: 0, pct: 0 });
  });

  it('should expose the over-target amount as a positive diffKcal when protein and fat pass the target', () => {
    const macros = macroTargets(
      { ...baseInput, proteinPerKg: 3, fatPerKg: 2.5, carbIsRemainder: true },
      WEIGHT_KG,
    );

    expect(macros.totalKcal).toBe(2277);
    expect(macros.diffKcal).toBe(277);
  });
});

describe('itemNutrients', () => {
  it('should scale per-100g values by quantity / 100', () => {
    expect(itemNutrients(CHICKEN_PER_100G, 120)).toEqual({ kcal: 190.8, protein: 38.4, carbs: 0, fat: 3, fiber: 0 });
  });

  it('should return zeros for a zero quantity', () => {
    expect(itemNutrients(CHICKEN_PER_100G, 0)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  });

  it('should round each nutrient to 2 decimals', () => {
    const per100g = { kcal: 33.333, protein: 1.111, carbs: 2.226, fat: 0.005, fiber: 0.7 };

    expect(itemNutrients(per100g, 50)).toEqual({ kcal: 16.67, protein: 0.56, carbs: 1.11, fat: 0, fiber: 0.35 });
  });
});

describe('mealTotals', () => {
  it('should sum the nutrients of every item', () => {
    const items = [
      { nutrients: { kcal: 100, protein: 10, carbs: 5, fat: 2, fiber: 1 } },
      { nutrients: { kcal: 50.5, protein: 1.5, carbs: 10, fat: 0.5, fiber: 2 } },
    ];

    expect(mealTotals(items)).toEqual({ kcal: 150.5, protein: 11.5, carbs: 15, fat: 2.5, fiber: 3 });
  });

  it('should return zeroed nutrients for an empty option', () => {
    expect(mealTotals([])).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  });
});

describe('dayTotals', () => {
  const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

  it('should sum only option 1 of each meal', () => {
    const meals = [
      {
        options: [
          { position: 2, totals: { ...zero, kcal: 999, protein: 99 } },
          { position: 1, totals: { ...zero, kcal: 300, protein: 20 } },
        ],
      },
      { options: [{ position: 1, totals: { ...zero, kcal: 500, protein: 30, fiber: 4 } }] },
    ];

    expect(dayTotals(meals)).toEqual({ kcal: 800, protein: 50, carbs: 0, fat: 0, fiber: 4 });
  });

  it('should return zeroed nutrients when there are no meals', () => {
    expect(dayTotals([])).toEqual(zero);
  });
});

describe('goalStatus', () => {
  const TOLERANCE = 0.05;
  const GOAL = 100;

  it.each([
    [100, GoalStatus.OK],
    [105, GoalStatus.OK],
    [95, GoalStatus.OK],
    [105.5, GoalStatus.HIGH],
    [94, GoalStatus.LOW],
  ])('should classify %f against a goal of 100 (+-5%%) as %s', (value, expected) => {
    expect(goalStatus(value, GOAL, { tolerance: TOLERANCE, isMinimum: false })).toBe(expected);
  });

  it('should default the tolerance to 5%', () => {
    expect(goalStatus(104, GOAL)).toBe(GoalStatus.OK);
    expect(goalStatus(106, GOAL)).toBe(GoalStatus.HIGH);
  });

  it('should treat a minimum goal (fiber) as ok when the value reaches it', () => {
    expect(goalStatus(25, 25, { isMinimum: true })).toBe(GoalStatus.OK);
  });

  it('should treat a minimum goal as ok when the value is far above it', () => {
    expect(goalStatus(60, 25, { isMinimum: true })).toBe(GoalStatus.OK);
  });

  it('should treat a minimum goal as low when the value is below it, even within 5%', () => {
    expect(goalStatus(24, 25, { isMinimum: true })).toBe(GoalStatus.LOW);
  });
});

describe('equivalentQuantity', () => {
  const chicken120g = { nutrients: itemNutrients(CHICKEN_PER_100G, 120) };

  it('should equalize protein: 120 g chicken (32 g/100 g) -> patinho (35.9 g/100 g) ~ 106.96 g', () => {
    const quantity = equivalentQuantity(chicken120g, { per100g: PATINHO_PER_100G }, Basis.PROTEIN);

    expect(quantity).toBeCloseTo(106.96, 2);
  });

  it('should equalize calories when the basis is kcal', () => {
    const quantity = equivalentQuantity(chicken120g, { per100g: PATINHO_PER_100G }, Basis.KCAL);

    expect(quantity).toBeCloseTo(87.12, 2);
  });

  it('should return the same quantity for the same food', () => {
    const quantity = equivalentQuantity(chicken120g, { per100g: CHICKEN_PER_100G }, Basis.PROTEIN);

    expect(quantity).toBe(120);
  });

  it('should reject with 422 nutrition.substitute.cannotEquate when the original item has none of the basis nutrient (protein)', () => {
    const oil = { nutrients: itemNutrients({ kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 }, 10) };

    expect(() => equivalentQuantity(oil, { per100g: PATINHO_PER_100G }, Basis.PROTEIN)).toThrow(
      expect.objectContaining({ httpStatus: 422, messageCode: 'nutrition.substitute.cannotEquate' }),
    );
  });

  it('should reject with 422 nutrition.substitute.cannotEquate when the original item has no calories (kcal basis)', () => {
    const water = { nutrients: itemNutrients({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }, 200) };

    expect(() => equivalentQuantity(water, { per100g: PATINHO_PER_100G }, Basis.KCAL)).toThrow(
      expect.objectContaining({ httpStatus: 422, messageCode: 'nutrition.substitute.cannotEquate' }),
    );
  });

  it('should round to 2 decimals', () => {
    const quantity = equivalentQuantity(chicken120g, { per100g: PATINHO_PER_100G }, Basis.PROTEIN);

    expect(quantity).toBe(Math.round(quantity * 100) / 100);
  });
});

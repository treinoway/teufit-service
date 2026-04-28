import { describe, it, expect } from 'vitest';
import {
  calculateTmb,
  calculateGet,
  scaleNutrient,
} from '../../src/services/tmb-calculator-service.js';
import { TmbFormula, ActivityLevel, PAL_MULTIPLIERS } from '../../src/constants/diet.js';

// ─── Reference values computed from the canonical formulas ──────────────────
// Mifflin-St Jeor male: 10*80 + 6.25*175 - 5*30 + 5 = 800 + 1093.75 - 150 + 5 = 1748.75
// Mifflin-St Jeor female: 10*65 + 6.25*165 - 5*25 - 161 = 650 + 1031.25 - 125 - 161 = 1395.25
// Harris-Benedict male: 88.362 + 13.397*80 + 4.799*175 - 5.677*30
//   = 88.362 + 1071.76 + 839.825 - 170.31 = 1829.637
// Harris-Benedict female: 447.593 + 9.247*65 + 3.098*165 - 4.33*25
//   = 447.593 + 601.055 + 511.17 - 108.25 = 1451.568
// FAO/WHO male 25yo: 15.3*80 + 679 = 1224 + 679 = 1903
// FAO/WHO female 25yo: 14.7*65 + 496 = 955.5 + 496 = 1451.5
// Cunningham: 500 + 22*70 = 500 + 1540 = 2040

const MALE_PARAMS = { weightKg: 80, heightCm: 175, ageYears: 30, gender: 'male' };
const FEMALE_PARAMS = { weightKg: 65, heightCm: 165, ageYears: 25, gender: 'female' };

describe('tmb-calculator-service', () => {
  // ─── calculateTmb ──────────────────────────────────────────────────────────

  describe('calculateTmb — Mifflin-St Jeor', () => {
    it('calculates correct TMB for male', () => {
      const result = calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, MALE_PARAMS);
      expect(result).toBeCloseTo(1748.75, 2);
    });

    it('calculates correct TMB for female', () => {
      const result = calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, FEMALE_PARAMS);
      expect(result).toBeCloseTo(1395.25, 2);
    });

    it('throws MISSING_TMB_PARAMETERS when weightKg is missing', async () => {
      const { weightKg: _w, ...params } = MALE_PARAMS;
      await expect(() =>
        calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, params),
      ).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });

    it('throws MISSING_TMB_PARAMETERS when heightCm is missing', () => {
      const { heightCm: _h, ...params } = MALE_PARAMS;
      expect(() => calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, params)).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });

    it('throws MISSING_TMB_PARAMETERS when ageYears is missing', () => {
      const { ageYears: _a, ...params } = MALE_PARAMS;
      expect(() => calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, params)).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });

    it('throws MISSING_TMB_PARAMETERS when gender is missing', () => {
      const { gender: _g, ...params } = MALE_PARAMS;
      expect(() => calculateTmb(TmbFormula.MIFFLIN_ST_JEOR, params)).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });
  });

  describe('calculateTmb — Harris-Benedict', () => {
    it('calculates correct TMB for male', () => {
      const result = calculateTmb(TmbFormula.HARRIS_BENEDICT, MALE_PARAMS);
      expect(result).toBeCloseTo(1829.637, 2);
    });

    it('calculates correct TMB for female', () => {
      const result = calculateTmb(TmbFormula.HARRIS_BENEDICT, FEMALE_PARAMS);
      expect(result).toBeCloseTo(1451.568, 2);
    });

    it('throws MISSING_TMB_PARAMETERS when all base params are absent', () => {
      expect(() => calculateTmb(TmbFormula.HARRIS_BENEDICT, {})).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });
  });

  describe('calculateTmb — FAO/WHO', () => {
    it('calculates correct TMB for male aged 25', () => {
      const result = calculateTmb(TmbFormula.FAO_WHO, { weightKg: 80, ageYears: 25, gender: 'male' });
      // 15.3 * 80 + 679 = 1903
      expect(result).toBeCloseTo(1903, 2);
    });

    it('calculates correct TMB for female aged 25', () => {
      const result = calculateTmb(TmbFormula.FAO_WHO, { weightKg: 65, ageYears: 25, gender: 'female' });
      // 14.7 * 65 + 496 = 1451.5
      expect(result).toBeCloseTo(1451.5, 2);
    });

    it('selects correct age bracket for male aged 10', () => {
      // male 10-18: 17.5 * 70 + 651 = 1225 + 651 = 1876
      const result = calculateTmb(TmbFormula.FAO_WHO, { weightKg: 70, ageYears: 10, gender: 'male' });
      expect(result).toBeCloseTo(1876, 2);
    });

    it('selects correct age bracket for male aged 60', () => {
      // male 60+: 13.5 * 75 + 487 = 1012.5 + 487 = 1499.5
      const result = calculateTmb(TmbFormula.FAO_WHO, { weightKg: 75, ageYears: 60, gender: 'male' });
      expect(result).toBeCloseTo(1499.5, 2);
    });

    it('throws MISSING_TMB_PARAMETERS when weightKg is missing', () => {
      expect(() =>
        calculateTmb(TmbFormula.FAO_WHO, { ageYears: 25, gender: 'male' }),
      ).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });

    it('throws MISSING_TMB_PARAMETERS when ageYears is missing', () => {
      expect(() =>
        calculateTmb(TmbFormula.FAO_WHO, { weightKg: 80, gender: 'male' }),
      ).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });

    it('throws MISSING_TMB_PARAMETERS when gender is missing', () => {
      expect(() =>
        calculateTmb(TmbFormula.FAO_WHO, { weightKg: 80, ageYears: 25 }),
      ).toThrowObject({
        code: 'MISSING_TMB_PARAMETERS',
        statusCode: 400,
      });
    });
  });

  describe('calculateTmb — Cunningham', () => {
    it('calculates correct TMB for given lean body mass', () => {
      // 500 + 22 * 70 = 2040
      const result = calculateTmb(TmbFormula.CUNNINGHAM, { leanBodyMassKg: 70 });
      expect(result).toBe(2040);
    });

    it('throws MISSING_LEAN_BODY_MASS when leanBodyMassKg is null', () => {
      expect(() =>
        calculateTmb(TmbFormula.CUNNINGHAM, { leanBodyMassKg: null }),
      ).toThrowObject({
        code: 'MISSING_LEAN_BODY_MASS',
        statusCode: 400,
      });
    });

    it('throws MISSING_LEAN_BODY_MASS when leanBodyMassKg is undefined', () => {
      expect(() =>
        calculateTmb(TmbFormula.CUNNINGHAM, {}),
      ).toThrowObject({
        code: 'MISSING_LEAN_BODY_MASS',
        statusCode: 400,
      });
    });

    it('does not require base anthropometric params (only lean mass needed)', () => {
      // Cunningham does not call requireBaseParams — must not throw for missing weightKg etc.
      expect(() =>
        calculateTmb(TmbFormula.CUNNINGHAM, { leanBodyMassKg: 60 }),
      ).not.toThrow();
    });
  });

  describe('calculateTmb — invalid formula', () => {
    it('throws INVALID_TMB_FORMULA for unknown formula string', () => {
      expect(() =>
        calculateTmb('katch_mcardle', MALE_PARAMS),
      ).toThrowObject({
        code: 'INVALID_TMB_FORMULA',
        statusCode: 400,
      });
    });

    it('throws INVALID_TMB_FORMULA for empty string', () => {
      expect(() => calculateTmb('', MALE_PARAMS)).toThrowObject({
        code: 'INVALID_TMB_FORMULA',
        statusCode: 400,
      });
    });

    it('throws INVALID_TMB_FORMULA for null formula', () => {
      expect(() => calculateTmb(null, MALE_PARAMS)).toThrowObject({
        code: 'INVALID_TMB_FORMULA',
        statusCode: 400,
      });
    });
  });

  // ─── calculateGet ──────────────────────────────────────────────────────────

  describe('calculateGet', () => {
    const tmbKcal = 1800;

    it('returns correct GET and PAL multiplier for sedentario', () => {
      const result = calculateGet(tmbKcal, ActivityLevel.SEDENTARIO);
      expect(result.palMultiplier).toBe(PAL_MULTIPLIERS.sedentario);
      expect(result.getKcal).toBeCloseTo(tmbKcal * PAL_MULTIPLIERS.sedentario, 4);
    });

    it('returns correct GET for levemente_ativo', () => {
      const result = calculateGet(tmbKcal, ActivityLevel.LEVEMENTE_ATIVO);
      expect(result.palMultiplier).toBe(PAL_MULTIPLIERS.levemente_ativo);
      expect(result.getKcal).toBeCloseTo(tmbKcal * 1.375, 4);
    });

    it('returns correct GET for moderadamente_ativo', () => {
      const result = calculateGet(tmbKcal, ActivityLevel.MODERADAMENTE_ATIVO);
      expect(result.palMultiplier).toBe(1.55);
      expect(result.getKcal).toBeCloseTo(tmbKcal * 1.55, 4);
    });

    it('returns correct GET for muito_ativo', () => {
      const result = calculateGet(tmbKcal, ActivityLevel.MUITO_ATIVO);
      expect(result.palMultiplier).toBe(1.725);
      expect(result.getKcal).toBeCloseTo(tmbKcal * 1.725, 4);
    });

    it('returns correct GET for extremamente_ativo', () => {
      const result = calculateGet(tmbKcal, ActivityLevel.EXTREMAMENTE_ATIVO);
      expect(result.palMultiplier).toBe(1.9);
      expect(result.getKcal).toBeCloseTo(tmbKcal * 1.9, 4);
    });

    it('throws INVALID_ACTIVITY_LEVEL for unknown activity level', () => {
      expect(() => calculateGet(tmbKcal, 'super_ativo')).toThrowObject({
        code: 'INVALID_ACTIVITY_LEVEL',
        statusCode: 400,
      });
    });

    it('throws INVALID_ACTIVITY_LEVEL for empty string', () => {
      expect(() => calculateGet(tmbKcal, '')).toThrowObject({
        code: 'INVALID_ACTIVITY_LEVEL',
        statusCode: 400,
      });
    });

    it('throws INVALID_ACTIVITY_LEVEL for null', () => {
      expect(() => calculateGet(tmbKcal, null)).toThrowObject({
        code: 'INVALID_ACTIVITY_LEVEL',
        statusCode: 400,
      });
    });

    it('returned object always contains both getKcal and palMultiplier keys', () => {
      const result = calculateGet(2000, ActivityLevel.SEDENTARIO);
      expect(result).toHaveProperty('getKcal');
      expect(result).toHaveProperty('palMultiplier');
    });
  });

  // ─── scaleNutrient ─────────────────────────────────────────────────────────

  describe('scaleNutrient', () => {
    it('scales protein correctly for 200g serving (value per 100g = 25)', () => {
      expect(scaleNutrient(25, 200)).toBe(50);
    });

    it('scales carbohydrates correctly for 150g serving', () => {
      expect(scaleNutrient(40, 150)).toBe(60);
    });

    it('rounds to 2 decimal places', () => {
      // 7 * 33 / 100 = 2.31
      expect(scaleNutrient(7, 33)).toBe(2.31);
    });

    it('returns null when valuePer100g is null', () => {
      expect(scaleNutrient(null, 100)).toBeNull();
    });

    it('returns null when valuePer100g is undefined', () => {
      expect(scaleNutrient(undefined, 100)).toBeNull();
    });

    it('handles Decimal objects by coercing to Number', () => {
      // Prisma Decimal objects are coerced via Number()
      const decimalLike = { valueOf: () => 10 };
      // Should not throw; Number({valueOf:() => 10}) works through coercion
      expect(() => scaleNutrient(decimalLike, 100)).not.toThrow();
    });

    it('returns 0 for quantityG of 0', () => {
      expect(scaleNutrient(25, 0)).toBe(0);
    });
  });
});

// ─── Custom matcher helper ──────────────────────────────────────────────────
// Vitest does not have a built-in toThrowObject matcher — use a small helper.
function toThrowObject(fn, expected) {
  try {
    fn();
    return { pass: false, message: () => 'Expected function to throw but it did not.' };
  } catch (err) {
    const mismatches = Object.entries(expected).filter(([key, val]) => err[key] !== val);
    if (mismatches.length === 0) return { pass: true, message: () => 'thrown as expected' };
    return {
      pass: false,
      message: () =>
        `Expected thrown error to match ${JSON.stringify(expected)} but got ` +
        JSON.stringify(Object.fromEntries(mismatches.map(([k]) => [k, err[k]]))),
    };
  }
}

expect.extend({
  toThrowObject(received, expected) {
    return toThrowObject(received, expected);
  },
});

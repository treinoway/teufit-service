import { AppError } from '../errors/app-error.js';
import { TmbFormula, ActivityLevel, PAL_MULTIPLIERS } from '../constants/diet.js';

/**
 * FAO/WHO TMB coefficients by age range and gender.
 * Each entry: [kcal_per_kg, constant_kcal]
 */
const FAO_WHO_COEFFICIENTS = {
  male: [
    { minAge: 0, maxAge: 3, coeffA: 60.9, coeffB: -54 },
    { minAge: 3, maxAge: 10, coeffA: 22.7, coeffB: 495 },
    { minAge: 10, maxAge: 18, coeffA: 17.5, coeffB: 651 },
    { minAge: 18, maxAge: 30, coeffA: 15.3, coeffB: 679 },
    { minAge: 30, maxAge: 60, coeffA: 11.6, coeffB: 879 },
    { minAge: 60, maxAge: Infinity, coeffA: 13.5, coeffB: 487 },
  ],
  female: [
    { minAge: 0, maxAge: 3, coeffA: 61.0, coeffB: -51 },
    { minAge: 3, maxAge: 10, coeffA: 22.5, coeffB: 499 },
    { minAge: 10, maxAge: 18, coeffA: 12.2, coeffB: 746 },
    { minAge: 18, maxAge: 30, coeffA: 14.7, coeffB: 496 },
    { minAge: 30, maxAge: 60, coeffA: 8.7, coeffB: 829 },
    { minAge: 60, maxAge: Infinity, coeffA: 10.5, coeffB: 596 },
  ],
};

function calculateMifflinStJeor({ weightKg, heightCm, ageYears, gender }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return gender === 'male' ? base + 5 : base - 161;
}

function calculateHarrisBenedict({ weightKg, heightCm, ageYears, gender }) {
  if (gender === 'male') {
    return 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * ageYears;
  }
  return 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * ageYears;
}

function calculateFaoWho({ weightKg, ageYears, gender }) {
  const genderKey = gender === 'male' ? 'male' : 'female';
  const coefficients = FAO_WHO_COEFFICIENTS[genderKey];

  const bracket = coefficients.find((c) => ageYears >= c.minAge && ageYears < c.maxAge);
  if (!bracket) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_TMB_PARAMETERS',
      messageCode: 'validation.failed',
      message: `Age ${ageYears} is out of FAO/WHO coefficient range.`,
    });
  }

  return bracket.coeffA * weightKg + bracket.coeffB;
}

function calculateCunningham({ leanBodyMassKg }) {
  if (leanBodyMassKg == null) {
    throw new AppError({
      httpStatus: 400,
      error: 'MISSING_LEAN_BODY_MASS',
      messageCode: 'validation.failed',
      message: 'Cunningham formula requires leanBodyMassKg.',
    });
  }
  return 500 + 22 * leanBodyMassKg;
}

function requireBaseParams({ weightKg, heightCm, ageYears, gender }, formula) {
  const missing = [];
  if (weightKg == null) missing.push('weightKg');
  if (heightCm == null) missing.push('heightCm');
  if (ageYears == null) missing.push('ageYears');
  if (!gender) missing.push('gender');

  if (missing.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'MISSING_TMB_PARAMETERS',
      messageCode: 'validation.failed',
      message: `Formula ${formula} requires: ${missing.join(', ')}.`,
    });
  }
}

/**
 * Calculate Basal Metabolic Rate (TMB/BMR).
 *
 * @param {string} formula - One of TmbFormula values
 * @param {{ weightKg, heightCm, ageYears, gender, leanBodyMassKg }} params
 * @returns {number} TMB in kcal/day
 */
export function calculateTmb(formula, params) {
  switch (formula) {
    case TmbFormula.MIFFLIN_ST_JEOR: {
      requireBaseParams(params, formula);
      return calculateMifflinStJeor(params);
    }
    case TmbFormula.HARRIS_BENEDICT: {
      requireBaseParams(params, formula);
      return calculateHarrisBenedict(params);
    }
    case TmbFormula.FAO_WHO: {
      if (params.weightKg == null || params.ageYears == null || !params.gender) {
        throw new AppError({
          httpStatus: 400,
          error: 'MISSING_TMB_PARAMETERS',
          messageCode: 'validation.failed',
          message: 'Formula fao_who requires: weightKg, ageYears, gender.',
        });
      }
      return calculateFaoWho(params);
    }
    case TmbFormula.CUNNINGHAM: {
      return calculateCunningham(params);
    }
    default: {
      throw new AppError({
        httpStatus: 400,
        error: 'INVALID_TMB_FORMULA',
        messageCode: 'validation.failed',
        message: `Invalid TMB formula: ${formula}. Valid values are: ${Object.values(TmbFormula).join(', ')}.`,
      });
    }
  }
}

/**
 * Calculate Total Energy Expenditure (GET/TEE) from TMB and activity level.
 *
 * @param {number} tmbKcal - TMB in kcal/day
 * @param {string} activityLevel - One of ActivityLevel values
 * @returns {{ getKcal: number, palMultiplier: number }}
 */
export function calculateGet(tmbKcal, activityLevel) {
  const palMultiplier = PAL_MULTIPLIERS[activityLevel];

  if (palMultiplier == null) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_ACTIVITY_LEVEL',
      messageCode: 'validation.failed',
      message: `Invalid activity level: ${activityLevel}. Valid values are: ${Object.values(ActivityLevel).join(', ')}.`,
    });
  }

  return {
    getKcal: tmbKcal * palMultiplier,
    palMultiplier,
  };
}

/**
 * Scale a nutrient value proportionally to a given quantity.
 * All food values are per 100g.
 *
 * @param {number|null|undefined} valuePer100g
 * @param {number} quantityG
 * @returns {number|null}
 */
export function scaleNutrient(valuePer100g, quantityG) {
  if (valuePer100g == null) return null;
  return Number(((Number(valuePer100g) * quantityG) / 100).toFixed(2));
}

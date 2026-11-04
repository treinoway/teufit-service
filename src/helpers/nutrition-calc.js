import { AppError } from '../errors/app-error.js';
import {
  BmrFormula,
  OBJECTIVE_ADJUSTMENT,
  GoalStatus,
  SwapBasis,
  GOAL_TOLERANCE,
  KCAL_PER_GRAM,
  DAYS_PER_WEEK,
  Sex,
  MAX_QUANTITY_COLUMN,
  NutritionErrorCode,
  NutritionMessageCode,
} from '../constants/nutrition.js';

const DECIMAL_FACTOR = 100;
const MINUTES_PER_HOUR = 60;
const PERCENT = 100;
const NUTRIENT_KEYS = Object.freeze(['kcal', 'protein', 'carbs', 'fat', 'fiber']);
const KATCH_BASE = 370;
const KATCH_LEAN_FACTOR = 21.6;
const FAO_YOUNG_ADULT_MAX_AGE = 30;
const FAO_ADULT_MAX_AGE = 60;

const FAO_WHO_TABLE = Object.freeze({
  [Sex.FEMALE]: [
    { maxAge: FAO_YOUNG_ADULT_MAX_AGE, weightFactor: 14.7, constant: 496 },
    { maxAge: FAO_ADULT_MAX_AGE, weightFactor: 8.7, constant: 829 },
    { maxAge: Infinity, weightFactor: 10.5, constant: 596 },
  ],
  [Sex.MALE]: [
    { maxAge: FAO_YOUNG_ADULT_MAX_AGE, weightFactor: 15.3, constant: 679 },
    { maxAge: FAO_ADULT_MAX_AGE, weightFactor: 11.6, constant: 879 },
    { maxAge: Infinity, weightFactor: 13.5, constant: 487 },
  ],
});

// Rounds to 2 decimal places.
export function round2(value) {
  return Math.round((value + Number.EPSILON) * DECIMAL_FACTOR) / DECIMAL_FACTOR;
}

// Builds a zeroed nutrients object.
export function zeroNutrients() {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
}

// Mifflin-St Jeor resting energy expenditure.
function mifflinBmr({ sex, age, weightKg, heightCm }) {
  const sexConstant = sex === Sex.MALE ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * age + sexConstant;
}

// Revised Harris-Benedict resting energy expenditure.
function harrisBenedictBmr({ sex, age, weightKg, heightCm }) {
  if (sex === Sex.MALE) return 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * age;
  return 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * age;
}

// FAO/WHO resting energy expenditure by sex and age bracket.
function faoWhoBmr({ sex, age, weightKg }) {
  const brackets = FAO_WHO_TABLE[sex] ?? FAO_WHO_TABLE[Sex.FEMALE];
  const bracket = brackets.find((candidate) => age < candidate.maxAge);
  return bracket.weightFactor * weightKg + bracket.constant;
}

// Katch-McArdle resting energy expenditure from lean mass; null without body fat.
function katchMcArdleBmr({ weightKg, bodyFatPct }) {
  if (bodyFatPct == null) return null;
  const leanMassKg = weightKg * (1 - bodyFatPct / PERCENT);
  return KATCH_BASE + KATCH_LEAN_FACTOR * leanMassKg;
}

const BMR_FORMULAS = Object.freeze({
  [BmrFormula.MIFFLIN]: mifflinBmr,
  [BmrFormula.HARRIS_BENEDICT]: harrisBenedictBmr,
  [BmrFormula.FAO_WHO]: faoWhoBmr,
  [BmrFormula.KATCH_MCARDLE]: katchMcArdleBmr,
});

// Whether every sheet field the formulas need is present.
function hasBmrInputs(sheet) {
  return [sheet?.age, sheet?.weightKg, sheet?.heightCm].every((value) => value != null) && sheet?.sex != null;
}

/**
 * Basal metabolic rate (kcal/day) for the plan formula and the patient sheet.
 *
 * @returns {number|null} null when the sheet lacks data the formula needs
 */
export function computeBmr(protocol, sheet) {
  const formula = BMR_FORMULAS[protocol?.bmrFormula];
  if (!formula || !hasBmrInputs(sheet)) return null;
  const bmr = formula(sheet);
  return bmr == null ? null : round2(bmr);
}

// Raw (unrounded) kcal/day of one activity.
function rawActivityKcal({ met, minutes, perWeek }, weightKg) {
  return (met * weightKg * (minutes / MINUTES_PER_HOUR) * perWeek) / DAYS_PER_WEEK;
}

// Average kcal/day of an activity: MET x kg x hours x sessions per week / 7.
export function activityKcalPerDay(activity, weightKg) {
  return round2(rawActivityKcal(activity, weightKg));
}

// Total energy expenditure: BMR x factor + kcal/day of the included activities.
export function computeTee({ bmr, factor, activities, weightKg }) {
  const activityKcal = activities
    .filter((activity) => activity.included)
    .reduce((sum, activity) => sum + rawActivityKcal(activity, weightKg), 0);
  return round2(bmr * factor + activityKcal);
}

// Suggested kcal target: TEE adjusted by the objective.
export function suggestTarget(tee, objective) {
  return round2(tee * (1 + (OBJECTIVE_ADJUSTMENT[objective] ?? 0)));
}

// Builds one macro entry (grams, kcal, %VET) from grams.
function macroEntry(grams, kcalPerGram, targetKcal) {
  const kcal = grams * kcalPerGram;
  return {
    grams: round2(grams),
    kcal: round2(kcal),
    pct: targetKcal > 0 ? round2((kcal / targetKcal) * PERCENT) : 0,
  };
}

/**
 * Macro targets from g/kg values; with carbIsRemainder the carbs close the kcal target (floored at 0 g).
 */
export function macroTargets(goals, weightKg) {
  const { kcal: targetKcal, proteinPerKg, fatPerKg, carbPerKg, carbIsRemainder } = goals;
  const proteinGrams = (proteinPerKg ?? 0) * weightKg;
  const fatGrams = (fatPerKg ?? 0) * weightKg;
  const fixedKcal = proteinGrams * KCAL_PER_GRAM.protein + fatGrams * KCAL_PER_GRAM.fat;
  const carbGrams = carbIsRemainder
    ? Math.max(0, (targetKcal - fixedKcal) / KCAL_PER_GRAM.carbs)
    : (carbPerKg ?? 0) * weightKg;

  const protein = macroEntry(proteinGrams, KCAL_PER_GRAM.protein, targetKcal);
  const fat = macroEntry(fatGrams, KCAL_PER_GRAM.fat, targetKcal);
  const carbs = macroEntry(carbGrams, KCAL_PER_GRAM.carbs, targetKcal);
  const totalKcal = round2(protein.kcal + fat.kcal + carbs.kcal);
  return { protein, carbs, fat, totalKcal, diffKcal: round2(totalKcal - targetKcal) };
}

// Nutrients of a quantity (g/ml) of a food given its per-100g values.
export function itemNutrients(per100g, quantity) {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [key, round2(((per100g[key] ?? 0) * quantity) / PERCENT)]),
  );
}

// Sums a list of nutrients objects.
function sumNutrients(list) {
  const total = zeroNutrients();
  for (const nutrients of list) {
    for (const key of NUTRIENT_KEYS) total[key] += nutrients[key] ?? 0;
  }
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, round2(total[key])]));
}

// Totals of the items of one meal option.
export function mealTotals(items) {
  return sumNutrients(items.map((item) => item.nutrients));
}

// Day totals: only option 1 of each meal counts.
export function dayTotals(meals) {
  const firstOptionTotals = meals
    .map((meal) => meal.options.find((option) => option.position === 1))
    .filter(Boolean)
    .map((option) => option.totals);
  return sumNutrients(firstOptionTotals);
}

// Compares a value with a goal: within tolerance is ok; a minimum goal (fiber) is ok when reached.
export function goalStatus(value, goal, { tolerance = GOAL_TOLERANCE, isMinimum = false } = {}) {
  if (isMinimum) return value >= goal ? GoalStatus.OK : GoalStatus.LOW;
  const allowedDeviation = goal * tolerance;
  if (value > goal + allowedDeviation) return GoalStatus.HIGH;
  if (value < goal - allowedDeviation) return GoalStatus.LOW;
  return GoalStatus.OK;
}

// Throws 422 because the nutrient used for the swap is missing on the original item or on the substitute.
function throwCannotEquate() {
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.SUBSTITUTE_CANNOT_EQUATE,
    messageCode: NutritionMessageCode.SUBSTITUTE_CANNOT_EQUATE,
    message: 'The original item or this food has none of the nutrient used for the swap, so they cannot be equated.',
  });
}

// Throws 422 when the equivalent quantity does not fit the quantity column.
function assertQuantityFits(quantity) {
  if (quantity <= MAX_QUANTITY_COLUMN) return;
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.SUBSTITUTE_QUANTITY_TOO_LARGE,
    messageCode: NutritionMessageCode.SUBSTITUTE_QUANTITY_TOO_LARGE,
    message: 'The equivalent quantity of this food is too large.',
  });
}

// Quantity of the substitute food that matches the original item protein or kcal.
export function equivalentQuantity(original, substituteFood, basis) {
  const nutrientKey = basis === SwapBasis.KCAL ? 'kcal' : 'protein';
  const perGram = (substituteFood.per100g[nutrientKey] ?? 0) / PERCENT;
  const originalAmount = original.nutrients[nutrientKey];
  if (!(perGram > 0) || !(originalAmount > 0)) throwCannotEquate();
  const quantity = round2(originalAmount / perGram);
  if (quantity <= 0) throwCannotEquate();
  assertQuantityFits(quantity);
  return quantity;
}

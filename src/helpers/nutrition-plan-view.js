import {
  computeBmr,
  computeTee,
  suggestTarget,
  macroTargets,
  itemNutrients,
  mealTotals,
  dayTotals,
  goalStatus,
} from './nutrition-calc.js';
import { toNumber } from './nutrition-sheet.js';
import { PlanStatus } from '../constants/nutrition.js';

// Per-100g nutrients object from the snapshot columns of an item/substitute row.
export function per100gFromRow(row) {
  return {
    kcal: toNumber(row.kcalPer100g),
    protein: toNumber(row.proteinPer100g),
    carbs: toNumber(row.carbsPer100g),
    fat: toNumber(row.fatPer100g),
    fiber: toNumber(row.fiberPer100g),
  };
}

// Snapshot columns of an item/substitute row from a per-100g nutrients object.
export function per100gToColumns(per100g) {
  return {
    kcalPer100g: per100g.kcal,
    proteinPer100g: per100g.protein,
    carbsPer100g: per100g.carbs,
    fatPer100g: per100g.fat,
    fiberPer100g: per100g.fiber,
  };
}

// Maps a substitute row to its view (with per100g kept for recomputation).
export function toSubstituteView(row) {
  const per100g = per100gFromRow(row);
  const quantity = toNumber(row.quantity);
  return {
    id: row.id,
    foodId: row.foodId,
    name: row.name,
    source: row.source,
    householdMeasure: row.householdMeasure,
    quantity,
    per100g,
    nutrients: itemNutrients(per100g, quantity),
  };
}

// Maps an item row to its view.
export function toItemView(row) {
  const per100g = per100gFromRow(row);
  const quantity = toNumber(row.quantity);
  return {
    id: row.id,
    foodId: row.foodId,
    name: row.name,
    source: row.source,
    householdMeasure: row.householdMeasure,
    quantity,
    unit: row.unit,
    per100g,
    nutrients: itemNutrients(per100g, quantity),
    swapBasis: row.swapBasis,
    order: row.order,
    substitutes: [...(row.substitutes ?? [])]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(toSubstituteView),
  };
}

// Maps an option row to its view with totals.
function toOptionView(row) {
  const items = [...row.items].sort((left, right) => left.order - right.order).map(toItemView);
  return { id: row.id, position: row.position, items, totals: mealTotals(items) };
}

// Maps a meal row to its view.
export function toMealView(row) {
  return {
    id: row.id,
    name: row.name,
    time: row.time,
    order: row.order,
    tip: row.tip,
    options: [...row.options].sort((left, right) => left.position - right.position).map(toOptionView),
  };
}

// Goals block of a plan row.
function toGoals(row) {
  return {
    bmrFormula: row.bmrFormula,
    activityFactor: toNumber(row.activityFactor),
    activities: row.activities ?? [],
    objective: row.objective,
    kcalTarget: toNumber(row.kcalTarget),
    proteinPerKg: toNumber(row.proteinPerKg),
    fatPerKg: toNumber(row.fatPerKg),
    carbPerKg: toNumber(row.carbPerKg),
    carbIsRemainder: row.carbIsRemainder,
    fiberMinG: toNumber(row.fiberMinG),
  };
}

// Supplement with dose and when always present (null when absent).
function normalizeSupplement(supplement) {
  return { name: supplement.name, dose: supplement.dose ?? null, when: supplement.when ?? null };
}

// Guidance block of a plan row.
function toGuidance(row) {
  return {
    waterTargetMl: row.waterTargetMl,
    freeMealsPerWeek: row.freeMealsPerWeek,
    freeMealText: row.freeMealText,
    supplements: (row.supplements ?? []).map(normalizeSupplement),
    observations: row.observations,
    patientMessage: row.patientMessage,
  };
}

// Status of a value against a goal, null when there is no goal.
function statusOrNull(value, goal, options) {
  return goal == null ? null : goalStatus(value, goal, options);
}

// Status of a macro against its target grams, null when the plan sets no goal for that macro.
function macroStatusOrNull(total, macroTarget, hasGoal) {
  return hasGoal ? statusOrNull(total, macroTarget?.grams) : null;
}

// Day status of each nutrient against the goals and macro targets.
function buildDayStatus(totals, goals, macros) {
  const hasCarbGoal = goals.carbPerKg != null || goals.carbIsRemainder;
  return {
    kcal: statusOrNull(totals.kcal, goals.kcalTarget),
    protein: macroStatusOrNull(totals.protein, macros?.protein, goals.proteinPerKg != null),
    carbs: macroStatusOrNull(totals.carbs, macros?.carbs, hasCarbGoal),
    fat: macroStatusOrNull(totals.fat, macros?.fat, goals.fatPerKg != null),
    fiber: statusOrNull(totals.fiber, goals.fiberMinG, { isMinimum: true }),
  };
}

// Energy expenditure block (BMR, TEE, suggested kcal), nulls when the sheet is incomplete.
function buildEnergy(goals, sheet) {
  const bmr = computeBmr(goals, sheet);
  if (bmr == null) return { bmr: null, tee: null, suggestedKcal: null };
  const tee = computeTee({ bmr, factor: goals.activityFactor, activities: goals.activities, weightKg: sheet.weightKg });
  return { bmr, tee, suggestedKcal: suggestTarget(tee, goals.objective) };
}

// Macro targets block, null without a kcal target or weight.
function buildMacros(goals, sheet) {
  if (goals.kcalTarget == null || sheet.weightKg == null) return null;
  return macroTargets({ ...goals, kcal: goals.kcalTarget }, sheet.weightKg);
}

// Computed block of a plan.
function buildComputed(goals, meals, sheet) {
  const energy = buildEnergy(goals, sheet);
  const macros = buildMacros(goals, sheet);
  const totals = dayTotals(meals);
  return { ...energy, macros, dayTotals: totals, dayStatus: buildDayStatus(totals, goals, macros) };
}

// Whether the plan has edits not yet published (always false for drafts).
export function hasPendingChanges(row) {
  return row.status === PlanStatus.PUBLISHED && row.hasUnpublishedChanges;
}

/**
 * Builds the Plan contract object from a plan row (with meals tree) and the patient sheet.
 */
export function buildPlanView(row, sheet) {
  const goals = toGoals(row);
  const meals = [...row.meals].sort((left, right) => left.order - right.order).map(toMealView);
  return {
    id: row.id,
    patientId: row.assigneeId,
    status: row.status,
    version: row.version,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    hasUnpublishedChanges: hasPendingChanges(row),
    goals,
    guidance: toGuidance(row),
    meals,
    computed: buildComputed(goals, meals, sheet),
  };
}

/**
 * Snapshot the patient app reads: what is published, frozen at publish time.
 */
export function buildSnapshot(view, nutritionistUser) {
  return {
    id: view.id,
    version: view.version,
    nutritionist: {
      firstName: nutritionistUser.firstName ?? null,
      lastName: nutritionistUser.lastName ?? null,
      avatarUrl: nutritionistUser.avatarUrl ?? null,
    },
    guidance: view.guidance,
    meals: view.meals,
  };
}

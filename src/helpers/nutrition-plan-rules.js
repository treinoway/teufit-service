import { AppError } from '../errors/app-error.js';
import { equivalentQuantity } from './nutrition-calc.js';
import {
  MAX_MEAL_OPTIONS,
  NutritionErrorCode,
  NutritionMessageCode,
} from '../constants/nutrition.js';

const UNPROCESSABLE = 422;

// Throws 422 when the meal already has the maximum number of options.
export function assertCanAddOption(options) {
  if (options.length < MAX_MEAL_OPTIONS) return;
  throw new AppError({
    httpStatus: UNPROCESSABLE,
    error: NutritionErrorCode.MEAL_MAX_OPTIONS,
    messageCode: NutritionMessageCode.MEAL_MAX_OPTIONS,
    message: `A meal can have at most ${MAX_MEAL_OPTIONS} options.`,
  });
}

// Copies a substitute without its identity.
function copySubstitute(substitute) {
  return {
    foodId: substitute.foodId,
    name: substitute.name,
    source: substitute.source,
    householdMeasure: substitute.householdMeasure,
    quantity: substitute.quantity,
    per100g: substitute.per100g,
  };
}

// Copies an item (and its substitutes) without identities.
function copyItem(item) {
  return {
    foodId: item.foodId,
    name: item.name,
    source: item.source,
    householdMeasure: item.householdMeasure,
    quantity: item.quantity,
    unit: item.unit,
    per100g: item.per100g,
    swapBasis: item.swapBasis,
    order: item.order,
    substitutes: item.substitutes.map(copySubstitute),
  };
}

// Builds the content of a new option as a copy of option 1.
export function buildOptionCopy(firstOption) {
  return { items: firstOption.items.map(copyItem) };
}

// Throws 422 when the plan has no meals (a kcal target is optional).
export function assertPublishable({ meals }) {
  if (meals.length === 0) {
    throw new AppError({
      httpStatus: UNPROCESSABLE,
      error: NutritionErrorCode.PLAN_NO_MEALS,
      messageCode: NutritionMessageCode.PLAN_NO_MEALS,
      message: 'Add at least one meal before publishing the plan.',
    });
  }
}

// Recomputes every substitute quantity of an item for a swap basis.
export function recomputeSubstituteQuantities(item, basis) {
  return item.substitutes.map((substitute) => ({
    ...substitute,
    quantity: equivalentQuantity(item, substitute, basis),
  }));
}

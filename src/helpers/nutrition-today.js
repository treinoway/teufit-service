import { AppError, NotFoundAppError } from '../errors/app-error.js';
import { todayInBusinessTz, addDaysMs, formatDateOnly } from './date-helpers.js';
import {
  MealStatus,
  DAY_WINDOW_FUTURE_DAYS,
  WATER_CUP_ML,
  WATER_MAX_TARGET_MULTIPLIER,
  FIRST_OPTION_POSITION,
  NutritionErrorCode,
  NutritionMessageCode,
} from '../constants/nutrition.js';

// Builds the plan-not-found error used for ids outside the published snapshot.
export function planNotFoundError() {
  return new NotFoundAppError({
    error: NutritionErrorCode.PLAN_NOT_FOUND,
    messageCode: NutritionMessageCode.PLAN_NOT_FOUND,
    message: 'Item not found in the published plan.',
  });
}

// Option the patient sees by default: the lowest position.
function defaultOption(meal) {
  return [...meal.options].sort((left, right) => left.position - right.position)[0];
}

// Option selected for the day; falls back to option 1 when the log refers to a removed option.
function selectedOption(meal, log) {
  const chosen = meal.options.find((option) => option.id === log?.optionId);
  return chosen ?? meal.options.find((option) => option.position === FIRST_OPTION_POSITION) ?? defaultOption(meal);
}

// Maps a substitute to its patient-facing shape.
function toTodaySubstitute(substitute) {
  return {
    id: substitute.id,
    name: substitute.name,
    householdMeasure: substitute.householdMeasure ?? null,
    quantity: substitute.quantity,
    nutrients: substitute.nutrients,
  };
}

// Maps the swap of the day (if any) to the patient-facing swappedTo.
function toSwappedTo(item, swapLog) {
  const substitute = item.substitutes.find((candidate) => candidate.id === swapLog?.substituteId);
  if (!substitute) return null;
  const { id, ...fields } = toTodaySubstitute(substitute);
  return { substituteId: id, ...fields };
}

// Maps a snapshot item to the patient-facing item for the day.
function toTodayItem(item, swapLogByItemId) {
  return {
    id: item.id,
    name: item.name,
    householdMeasure: item.householdMeasure ?? null,
    quantity: item.quantity,
    unit: item.unit,
    nutrients: item.nutrients,
    canSwap: item.substitutes.length > 0,
    swappedTo: toSwappedTo(item, swapLogByItemId.get(item.id)),
    substitutes: item.substitutes.map(toTodaySubstitute),
  };
}

// Maps a snapshot meal plus its day log to the patient-facing meal.
function toTodayMeal(meal, log, swapLogByItemId) {
  return {
    id: meal.id,
    name: meal.name,
    time: meal.time,
    order: meal.order,
    tip: meal.tip ?? null,
    status: log?.status ?? MealStatus.PENDING,
    doneAt: log?.doneAt ? new Date(log.doneAt).toISOString() : null,
    note: log?.note ?? null,
    selectedOptionId: selectedOption(meal, log).id,
    options: meal.options.map((option) => ({
      id: option.id,
      position: option.position,
      items: option.items.map((item) => toTodayItem(item, swapLogByItemId)),
      totals: option.totals,
    })),
  };
}

// Water block of the day.
function toWater(snapshot, waterMl) {
  return { targetMl: snapshot.guidance.waterTargetMl ?? null, consumedMl: waterMl, cupMl: WATER_CUP_ML };
}

// Free meal block; null when none are allowed.
function toFreeMeal({ freeMealsPerWeek, freeMealText }) {
  if (!freeMealsPerWeek) return null;
  return { perWeek: freeMealsPerWeek, text: freeMealText ?? null };
}

// Builds the patient's "today" view from the published snapshot and the day logs.
export function buildToday({ date, snapshot, mealLogs, swapLogs, waterMl }) {
  if (!snapshot) return { date, plan: null };

  const logByMealId = new Map(mealLogs.map((log) => [log.mealId, log]));
  const swapLogByItemId = new Map(swapLogs.map((log) => [log.itemId, log]));
  const meals = [...snapshot.meals]
    .sort((left, right) => left.order - right.order)
    .map((meal) => toTodayMeal(meal, logByMealId.get(meal.id), swapLogByItemId));
  const nextMeal = meals.find((meal) => meal.status === MealStatus.PENDING);

  return {
    date,
    plan: {
      id: snapshot.id,
      version: snapshot.version,
      nutritionist: snapshot.nutritionist,
      patientMessage: snapshot.guidance.patientMessage ?? null,
      water: toWater(snapshot, waterMl),
      freeMeal: toFreeMeal(snapshot.guidance),
      supplements: snapshot.guidance.supplements ?? [],
      meals,
      mealsDone: meals.filter((meal) => meal.status === MealStatus.DONE).length,
      mealsTotal: meals.length,
      nextMealId: nextMeal ? nextMeal.id : null,
    },
  };
}

// Highest water total accepted for a day: 2x the target.
export function maxWaterMl(targetMl) {
  return WATER_MAX_TARGET_MULTIPLIER * targetMl;
}

// New water total after a delta, clamped to [0, 2x target].
export function clampWater(currentMl, deltaMl, targetMl) {
  return Math.min(maxWaterMl(targetMl), Math.max(0, currentMl + deltaMl));
}

// Finds an item anywhere in the snapshot.
export function findSnapshotItem(snapshot, itemId) {
  for (const meal of snapshot.meals) {
    for (const option of meal.options) {
      const item = option.items.find((candidate) => candidate.id === itemId);
      if (item) return item;
    }
  }
  return null;
}

// Finds a meal in the snapshot or throws 404 nutrition.plan.notFound.
export function requireSnapshotMeal(snapshot, mealId) {
  const meal = snapshot.meals.find((candidate) => candidate.id === mealId);
  if (!meal) throw planNotFoundError();
  return meal;
}

// Throws 404 when the option is not part of the meal.
export function assertOptionInMeal(meal, optionId) {
  if (!meal.options.some((option) => option.id === optionId)) throw planNotFoundError();
}

// Validates a swap against the published snapshot: 404 for unknown items, 422 for substitutes not released.
export function assertSwapAllowed(snapshot, itemId, substituteId) {
  const item = findSnapshotItem(snapshot, itemId);
  if (!item) throw planNotFoundError();
  if (item.substitutes.some((substitute) => substitute.id === substituteId)) return;
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.SWAP_NOT_ALLOWED,
    messageCode: NutritionMessageCode.SWAP_NOT_ALLOWED,
    message: 'This substitute was not released for this item.',
  });
}

/**
 * Writable day window of a published plan: [first published day, today + 1] in the business timezone (midnight-UTC dates).
 */
export function writableDayWindow({ firstPublishedAt, now = new Date() }) {
  const today = todayInBusinessTz(now);
  const firstDay = firstPublishedAt ? todayInBusinessTz(new Date(firstPublishedAt)) : today;
  return { from: firstDay, to: addDaysMs(today, DAY_WINDOW_FUTURE_DAYS) };
}

/**
 * Throws 422 nutrition.day.outOfRange unless the YYYY-MM-DD date is inside the writable window.
 */
export function assertDayWritable(date, { firstPublishedAt, now } = {}) {
  const { from, to } = writableDayWindow({ firstPublishedAt, now });
  if (date >= formatDateOnly(from) && date <= formatDateOnly(to)) return;
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.DAY_OUT_OF_RANGE,
    messageCode: NutritionMessageCode.DAY_OUT_OF_RANGE,
    message: 'This day is outside the period in which the plan can be logged.',
  });
}

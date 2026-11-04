import { todayInBusinessTz, diffInDays, addDaysMs } from '../helpers/date-helpers.js';
import { ADHERENCE_WINDOW_DAYS, DAY_WINDOW_FUTURE_DAYS, MealLogStatus, PlanStatus } from '../constants/nutrition.js';

const PERCENT = 100;

// Most frequent key of a list (first one wins ties); null for an empty list.
function mostFrequent(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  let best = null;
  for (const [key, count] of counts) {
    if (best === null || count > counts.get(best)) best = key;
  }
  return best;
}

// First day (midnight UTC) of the adherence window.
function windowStart(today) {
  return addDaysMs(today, -(ADHERENCE_WINDOW_DAYS - 1));
}

// First day of the window in which the plan counts: the later of the window start and the first publication.
function planWindowStart(plan, today) {
  const start = windowStart(today);
  const firstPublishedDay = plan.firstPublishedAt ? todayInBusinessTz(plan.firstPublishedAt) : today;
  return firstPublishedDay > start ? firstPublishedDay : start;
}

// Number of days of the window in which the plan was already published.
function publishedDaysInWindow(plan, today) {
  return Math.min(ADHERENCE_WINDOW_DAYS, Math.max(0, diffInDays(today, planWindowStart(plan, today)) + 1));
}

// Keeps the logs inside the writable window of the plan (first published day to tomorrow).
function logsInPlanWindow(logs, plan, today) {
  const from = planWindowStart(plan, today).getTime();
  const to = addDaysMs(today, DAY_WINDOW_FUTURE_DAYS).getTime();
  return logs.filter((log) => log.date.getTime() >= from && log.date.getTime() <= to);
}

// Index of snapshot meals, items and substitutes by id.
function indexSnapshot(snapshot) {
  const meals = new Map();
  const items = new Map();
  const substitutes = new Map();
  for (const meal of snapshot.meals) {
    meals.set(meal.id, meal);
    for (const option of meal.options) {
      for (const item of option.items) {
        items.set(item.id, item);
        for (const substitute of item.substitutes) substitutes.set(substitute.id, substitute);
      }
    }
  }
  return { meals, items, substitutes };
}

// Swap summary: total and the most requested original -> substitute pair.
function summarizeSwaps(swapLogs, index) {
  const valid = swapLogs.filter((log) => index.items.has(log.itemId) && index.substitutes.has(log.substituteId));
  const topKey = mostFrequent(valid.map((log) => `${log.itemId}|${log.substituteId}`));
  if (!topKey) return { total: valid.length, topPair: null };
  const [itemId, substituteId] = topKey.split('|');
  return {
    total: valid.length,
    topPair: { from: index.items.get(itemId).name, to: index.substitutes.get(substituteId).name },
  };
}

// "Ate differently" summary: total and the meal where it happens most.
function summarizeDifferent(mealLogs, index) {
  const different = mealLogs.filter((log) => log.status === MealLogStatus.DIFFERENT && index.meals.has(log.mealId));
  const topMealId = mostFrequent(different.map((log) => log.mealId));
  return { total: different.length, topMealName: topMealId ? index.meals.get(topMealId).name : null };
}

// Adherence of one published plan given its window logs.
function summarizePlan(plan, allMealLogs, allSwapLogs, today) {
  const index = indexSnapshot(plan.publishedSnapshot);
  const mealLogs = logsInPlanWindow(allMealLogs, plan, today);
  const swapLogs = logsInPlanWindow(allSwapLogs, plan, today);
  const doneLogs = mealLogs.filter((log) => log.date.getTime() <= today.getTime());
  const mealsDone = doneLogs.filter((log) => log.status === MealLogStatus.DONE && index.meals.has(log.mealId)).length;
  const mealsExpected = index.meals.size * publishedDaysInWindow(plan, today);
  return {
    mealsDone,
    mealsExpected,
    percent: mealsExpected > 0 ? Math.min(PERCENT, Math.round((mealsDone / mealsExpected) * PERCENT)) : 0,
    swaps: summarizeSwaps(swapLogs, index),
    ateDifferent: summarizeDifferent(mealLogs, index),
  };
}

// Groups rows by plan id.
function groupByPlan(rows) {
  const groups = new Map();
  for (const row of rows) groups.set(row.planId, [...(groups.get(row.planId) ?? []), row]);
  return groups;
}

/**
 * 7-day adherence per patient for the given plans (published ones only).
 *
 * @returns {Promise<Map<string, object>>} patientId -> { mealsDone, mealsExpected, percent, swaps, ateDifferent }
 */
export async function loadAdherenceByPatient(prisma, plans) {
  const published = plans.filter((plan) => plan.status === PlanStatus.PUBLISHED && plan.publishedSnapshot);
  const result = new Map();
  if (published.length === 0) return result;

  const today = todayInBusinessTz();
  // why: the upper bound is tomorrow (like the writable window), so logs written near midnight still count but inflated future dates do not.
  const where = {
    planId: { in: published.map((plan) => plan.id) },
    date: { gte: windowStart(today), lte: addDaysMs(today, DAY_WINDOW_FUTURE_DAYS) },
  };
  const [mealLogs, swapLogs] = await Promise.all([
    prisma.dietMealLog.findMany({ where: { ...where, status: { not: null } } }),
    prisma.dietSwapLog.findMany({ where }),
  ]);
  const mealLogsByPlan = groupByPlan(mealLogs);
  const swapLogsByPlan = groupByPlan(swapLogs);
  for (const plan of published) {
    result.set(plan.assigneeId, summarizePlan(plan, mealLogsByPlan.get(plan.id) ?? [], swapLogsByPlan.get(plan.id) ?? [], today));
  }
  return result;
}

// Zeroed adherence for patients without a published plan (overview).
export function emptyAdherence() {
  return {
    mealsDone: 0,
    mealsExpected: 0,
    percent: 0,
    swaps: { total: 0, topPair: null },
    ateDifferent: { total: 0, topMealName: null },
  };
}

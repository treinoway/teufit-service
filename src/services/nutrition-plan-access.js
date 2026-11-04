import { NotFoundAppError } from '../errors/app-error.js';
import { buildPlanView } from '../helpers/nutrition-plan-view.js';
import { getSheet } from './nutrition-sheet-service.js';
import { requirePatientLink } from './nutritionist-patient-service.js';
import { NutritionErrorCode, NutritionMessageCode } from '../constants/nutrition.js';

const ITEMS_INCLUDE = { orderBy: { order: 'asc' }, include: { substitutes: true } };
const OPTIONS_INCLUDE = { orderBy: { position: 'asc' }, include: { items: ITEMS_INCLUDE } };

export const PLAN_INCLUDE = Object.freeze({
  meals: { orderBy: { order: 'asc' }, include: { options: OPTIONS_INCLUDE } },
});

// Builds a 404 for a missing nutrition entity.
function notFound(error, messageCode, message) {
  return new NotFoundAppError({ error, messageCode, message });
}

const PROTOCOL_ASSIGNEE = { select: { assigneeId: true } };

// Loads a plan owned by the nutritionist whose patient is still actively linked (404 otherwise: no writes after unlinking).
export async function requireOwnedPlan(prisma, { nutritionistId, planId }) {
  const plan = await prisma.dietProtocol.findFirst({ where: { id: planId, nutritionistId } });
  if (!plan) {
    throw notFound(NutritionErrorCode.PLAN_NOT_FOUND, NutritionMessageCode.PLAN_NOT_FOUND, 'Plan not found.');
  }
  await requirePatientLink(prisma, { nutritionistId, patientId: plan.assigneeId });
  return plan;
}

// Loads a meal (with options, items and substitutes) of the nutritionist's plans or throws 404.
export async function requireOwnedMeal(prisma, { nutritionistId, mealId }) {
  const meal = await prisma.dietMeal.findFirst({
    where: { id: mealId, protocol: { nutritionistId } },
    include: { options: OPTIONS_INCLUDE, protocol: PROTOCOL_ASSIGNEE },
  });
  if (!meal) {
    throw notFound(NutritionErrorCode.MEAL_NOT_FOUND, NutritionMessageCode.MEAL_NOT_FOUND, 'Meal not found.');
  }
  await requirePatientLink(prisma, { nutritionistId, patientId: meal.protocol.assigneeId });
  return meal;
}

// Loads an option with its meal, or throws 404.
export async function requireOwnedOption(prisma, { nutritionistId, optionId }) {
  const option = await prisma.dietMealOption.findFirst({
    where: { id: optionId, meal: { protocol: { nutritionistId } } },
    include: { meal: { include: { protocol: PROTOCOL_ASSIGNEE } }, items: ITEMS_INCLUDE },
  });
  if (!option) {
    throw notFound(NutritionErrorCode.OPTION_NOT_FOUND, NutritionMessageCode.OPTION_NOT_FOUND, 'Meal option not found.');
  }
  await requirePatientLink(prisma, { nutritionistId, patientId: option.meal.protocol.assigneeId });
  return option;
}

// Loads an item with its option, meal and substitutes, or throws 404.
export async function requireOwnedItem(prisma, { nutritionistId, itemId }) {
  const item = await prisma.dietFoodItem.findFirst({
    where: { id: itemId, option: { meal: { protocol: { nutritionistId } } } },
    include: { substitutes: true, option: { include: { meal: { include: { protocol: PROTOCOL_ASSIGNEE } }, items: true } } },
  });
  if (!item) {
    throw notFound(NutritionErrorCode.ITEM_NOT_FOUND, NutritionMessageCode.ITEM_NOT_FOUND, 'Item not found.');
  }
  await requirePatientLink(prisma, { nutritionistId, patientId: item.option.meal.protocol.assigneeId });
  return item;
}

// Loads a substitute with its item chain, or throws 404.
export async function requireOwnedSubstitute(prisma, { nutritionistId, substituteId }) {
  const substitute = await prisma.dietItemSubstitute.findFirst({
    where: { id: substituteId, item: { option: { meal: { protocol: { nutritionistId } } } } },
    include: { item: { include: { option: { include: { meal: { include: { protocol: PROTOCOL_ASSIGNEE } } } } } } },
  });
  if (!substitute) {
    throw notFound(NutritionErrorCode.SUBSTITUTE_NOT_FOUND, NutritionMessageCode.SUBSTITUTE_NOT_FOUND, 'Substitute not found.');
  }
  await requirePatientLink(prisma, { nutritionistId, patientId: substitute.item.option.meal.protocol.assigneeId });
  return substitute;
}

// Flags the plan as edited (the app keeps the old snapshot until republish).
export async function markPlanChanged(prisma, planId) {
  await prisma.dietProtocol.update({ where: { id: planId }, data: { hasUnpublishedChanges: true } });
}

/**
 * Loads the full Plan contract object for a plan owned by the nutritionist.
 */
export async function loadPlanView(prisma, { nutritionistId, planId }) {
  const row = await prisma.dietProtocol.findFirst({
    where: { id: planId, nutritionistId },
    include: PLAN_INCLUDE,
  });
  if (!row) {
    throw notFound(NutritionErrorCode.PLAN_NOT_FOUND, NutritionMessageCode.PLAN_NOT_FOUND, 'Plan not found.');
  }
  const sheet = await getSheet(prisma, { nutritionistId, patientId: row.assigneeId });
  return buildPlanView(row, sheet);
}

import { AppError } from '../errors/app-error.js';
import { assertCanAddOption, buildOptionCopy, recomputeSubstituteQuantities } from '../helpers/nutrition-plan-rules.js';
import { equivalentQuantity } from '../helpers/nutrition-calc.js';
import { foodPer100g, defaultQuantity } from '../helpers/nutrition-food.js';
import { toItemView, per100gToColumns } from '../helpers/nutrition-plan-view.js';
import { lockDietProtocolForUpdate } from '../helpers/row-locks.js';
import { requireAccessibleFood } from './food-service.js';
import {
  loadPlanView,
  markPlanChanged,
  requireOwnedPlan,
  requireOwnedMeal,
  requireOwnedOption,
  requireOwnedItem,
  requireOwnedSubstitute,
} from './nutrition-plan-access.js';
import {
  MAX_MEAL_OPTIONS,
  FIRST_OPTION_POSITION,
  QuantityUnit,
  SwapBasis,
  NutritionErrorCode,
  NutritionMessageCode,
} from '../constants/nutrition.js';

// Runs a write in a transaction under the plan row lock (plan before children, always), flags the plan as changed and returns the fresh Plan.
async function writeAndReload(prisma, { nutritionistId, planId, write, shouldLockPlan = true }) {
  await prisma.$transaction(async (tx) => {
    if (shouldLockPlan) await lockDietProtocolForUpdate(tx, planId);
    await write(tx);
    await markPlanChanged(tx, planId);
  });
  return loadPlanView(prisma, { nutritionistId, planId });
}

// Next sequential order for a list of rows (0 when empty).
function nextOrder(rows) {
  return rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.order)) + 1;
}

/**
 * Adds a meal (with one empty option) at the end of the plan.
 */
export async function createMeal(prisma, { nutritionistId, planId, data }) {
  await requireOwnedPlan(prisma, { nutritionistId, planId });
  const lastMeal = await prisma.dietMeal.findFirst({ where: { dietProtocolId: planId }, orderBy: { order: 'desc' } });
  return writeAndReload(prisma, {
    nutritionistId,
    planId,
    write: (tx) =>
      tx.dietMeal.create({
        data: {
          dietProtocolId: planId,
          name: data.name,
          time: data.time,
          tip: data.tip ?? null,
          order: lastMeal ? lastMeal.order + 1 : 0,
          options: { create: { position: FIRST_OPTION_POSITION } },
        },
      }),
  });
}

/**
 * Edits name, time and tip of a meal.
 */
export async function updateMeal(prisma, { nutritionistId, mealId, data }) {
  const meal = await requireOwnedMeal(prisma, { nutritionistId, mealId });
  const { name, time, tip } = data;
  return writeAndReload(prisma, {
    nutritionistId,
    planId: meal.dietProtocolId,
    write: (tx) =>
      tx.dietMeal.update({
        where: { id: mealId },
        data: {
          ...(name !== undefined && { name }),
          ...(time !== undefined && { time }),
          ...(tip !== undefined && { tip }),
        },
      }),
  });
}

/**
 * Removes a meal.
 */
export async function deleteMeal(prisma, { nutritionistId, mealId }) {
  const meal = await requireOwnedMeal(prisma, { nutritionistId, mealId });
  return writeAndReload(prisma, {
    nutritionistId,
    planId: meal.dietProtocolId,
    write: (tx) => tx.dietMeal.delete({ where: { id: mealId } }),
  });
}

// Throws 422 unless the ids are exactly the plan meals, once each.
function assertSameMeals(currentMeals, mealIds) {
  const currentIds = new Set(currentMeals.map((meal) => meal.id));
  const isSameSet = mealIds.length === currentIds.size && mealIds.every((id) => currentIds.has(id)) && new Set(mealIds).size === mealIds.length;
  if (isSameSet) return;
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.MEAL_INVALID_ORDER,
    messageCode: NutritionMessageCode.MEAL_INVALID_ORDER,
    message: 'The meal list must contain every meal of the plan exactly once.',
  });
}

/**
 * Reorders the meals of a plan.
 */
export async function reorderMeals(prisma, { nutritionistId, planId, mealIds }) {
  await requireOwnedPlan(prisma, { nutritionistId, planId });
  const currentMeals = await prisma.dietMeal.findMany({ where: { dietProtocolId: planId }, select: { id: true } });
  assertSameMeals(currentMeals, mealIds);
  return writeAndReload(prisma, {
    nutritionistId,
    planId,
    write: async (tx) => {
      for (const [index, id] of mealIds.entries()) {
        await tx.dietMeal.update({ where: { id }, data: { order: index } });
      }
    },
  });
}

// Lowest free option position within 1..MAX.
function nextFreePosition(options) {
  const taken = new Set(options.map((option) => option.position));
  for (let position = FIRST_OPTION_POSITION; position <= MAX_MEAL_OPTIONS; position += 1) {
    if (!taken.has(position)) return position;
  }
  return null;
}

// Nested create payload of an item copy.
function toItemCreate(copy) {
  return {
    foodId: copy.foodId,
    source: copy.source,
    name: copy.name,
    householdMeasure: copy.householdMeasure,
    quantity: copy.quantity,
    unit: copy.unit,
    swapBasis: copy.swapBasis,
    order: copy.order,
    ...per100gToColumns(copy.per100g),
    substitutes: {
      create: copy.substitutes.map((substitute) => ({
        foodId: substitute.foodId,
        source: substitute.source,
        name: substitute.name,
        householdMeasure: substitute.householdMeasure,
        quantity: substitute.quantity,
        ...per100gToColumns(substitute.per100g),
      })),
    },
  };
}

/**
 * Adds an option copying option 1 (max 3).
 */
export async function addOption(prisma, { nutritionistId, mealId }) {
  const meal = await requireOwnedMeal(prisma, { nutritionistId, mealId });
  return writeAndReload(prisma, {
    nutritionistId,
    planId: meal.dietProtocolId,
    write: async (tx) => {
      const current = await requireOwnedMeal(tx, { nutritionistId, mealId });
      assertCanAddOption(current.options);
      const firstOption = current.options.find((option) => option.position === FIRST_OPTION_POSITION) ?? current.options[0];
      const copy = buildOptionCopy({ items: firstOption.items.map(toItemView) });
      await tx.dietMealOption.create({
        data: {
          mealId,
          position: nextFreePosition(current.options),
          items: { create: copy.items.map(toItemCreate) },
        },
      });
    },
  });
}

/**
 * Removes an option; option 1 cannot be removed.
 */
export async function deleteOption(prisma, { nutritionistId, optionId }) {
  const option = await requireOwnedOption(prisma, { nutritionistId, optionId });
  if (option.position === FIRST_OPTION_POSITION) {
    throw new AppError({
      httpStatus: 422,
      error: NutritionErrorCode.MEAL_FIRST_OPTION_REQUIRED,
      messageCode: NutritionMessageCode.MEAL_FIRST_OPTION_REQUIRED,
      message: 'The first option of a meal cannot be removed.',
    });
  }
  return writeAndReload(prisma, {
    nutritionistId,
    planId: option.meal.dietProtocolId,
    write: (tx) => tx.dietMealOption.delete({ where: { id: optionId } }),
  });
}

/**
 * Adds a food to an option (defaults to the food portion).
 */
export async function addItem(prisma, { nutritionistId, optionId, data }) {
  const option = await requireOwnedOption(prisma, { nutritionistId, optionId });
  const food = await requireAccessibleFood(prisma, { nutritionistId, foodId: data.foodId });
  return writeAndReload(prisma, {
    nutritionistId,
    planId: option.meal.dietProtocolId,
    write: (tx) =>
      tx.dietFoodItem.create({
        data: {
          dietMealOptionId: optionId,
          foodId: food.id,
          source: food.source,
          name: food.name,
          householdMeasure: data.householdMeasure ?? food.servingSizeDescription ?? null,
          quantity: data.quantity ?? defaultQuantity(food),
          unit: data.unit ?? QuantityUnit.GRAM,
          swapBasis: SwapBasis.PROTEIN,
          order: nextOrder(option.items),
          ...per100gToColumns(foodPer100g(food)),
        },
      }),
  });
}

// Moves an item to a new position within its option and renumbers siblings.
async function moveItem(tx, { item, newOrder }) {
  const siblings = item.option.items.filter((sibling) => sibling.id !== item.id).sort((left, right) => left.order - right.order);
  siblings.splice(Math.min(Math.max(newOrder, 0), siblings.length), 0, item);
  for (const [index, sibling] of siblings.entries()) {
    await tx.dietFoodItem.update({ where: { id: sibling.id }, data: { order: index } });
  }
}

// Recomputes substitute quantities of an item after its quantity or swap basis changed.
async function recomputeSubstitutes(tx, { item, quantity, swapBasis }) {
  const view = toItemView({ ...item, quantity, swapBasis });
  const recomputed = recomputeSubstituteQuantities(view, swapBasis);
  for (const substitute of recomputed) {
    await tx.dietItemSubstitute.update({ where: { id: substitute.id }, data: { quantity: substitute.quantity } });
  }
}

// Scalar columns changed by a PATCH of an item.
function itemScalarChanges({ quantity, unit, householdMeasure, swapBasis }) {
  return {
    ...(quantity !== undefined && { quantity }),
    ...(unit !== undefined && { unit }),
    ...(householdMeasure !== undefined && { householdMeasure }),
    ...(swapBasis !== undefined && { swapBasis }),
  };
}

/**
 * Edits an item (quantity, unit, measure, swap basis, order); substitutes are re-equalized.
 */
export async function updateItem(prisma, { nutritionistId, itemId, data }) {
  const item = await requireOwnedItem(prisma, { nutritionistId, itemId });
  const quantity = data.quantity ?? Number(item.quantity);
  const swapBasis = data.swapBasis ?? item.swapBasis;
  const needsRecompute = data.quantity !== undefined || data.swapBasis !== undefined;
  return writeAndReload(prisma, {
    nutritionistId,
    planId: item.option.meal.dietProtocolId,
    write: async (tx) => {
      await tx.dietFoodItem.update({ where: { id: itemId }, data: itemScalarChanges(data) });
      if (needsRecompute) await recomputeSubstitutes(tx, { item, quantity, swapBasis });
      if (data.order !== undefined) await moveItem(tx, { item, newOrder: data.order });
    },
  });
}

/**
 * Removes an item.
 */
export async function deleteItem(prisma, { nutritionistId, itemId }) {
  const item = await requireOwnedItem(prisma, { nutritionistId, itemId });
  return writeAndReload(prisma, {
    nutritionistId,
    planId: item.option.meal.dietProtocolId,
    write: (tx) => tx.dietFoodItem.delete({ where: { id: itemId } }),
  });
}

/**
 * Releases a substitute food for an item, with the quantity that equalizes the item.
 */
export async function addSubstitute(prisma, { nutritionistId, itemId, foodId }) {
  const item = await requireOwnedItem(prisma, { nutritionistId, itemId });
  const food = await requireAccessibleFood(prisma, { nutritionistId, foodId });
  const per100g = foodPer100g(food);
  const quantity = equivalentQuantity(toItemView(item), { per100g }, item.swapBasis);
  return writeAndReload(prisma, {
    nutritionistId,
    planId: item.option.meal.dietProtocolId,
    write: (tx) =>
      tx.dietItemSubstitute.create({
        data: {
          dietFoodItemId: itemId,
          foodId: food.id,
          source: food.source,
          name: food.name,
          householdMeasure: null,
          quantity,
          ...per100gToColumns(per100g),
        },
      }),
  });
}

/**
 * Removes a substitute.
 */
export async function removeSubstitute(prisma, { nutritionistId, substituteId }) {
  const substitute = await requireOwnedSubstitute(prisma, { nutritionistId, substituteId });
  return writeAndReload(prisma, {
    nutritionistId,
    planId: substitute.item.option.meal.dietProtocolId,
    write: (tx) => tx.dietItemSubstitute.delete({ where: { id: substituteId } }),
  });
}

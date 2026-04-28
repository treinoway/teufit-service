import { AppError } from '../errors/app-error.js';
import { DietErrorCode, DietMessageCode } from '../constants/diet.js';
import { scaleNutrient } from './tmb-calculator-service.js';

function buildDietError(errorCode, messageCode, message, httpStatus = 400) {
  return new AppError({ httpStatus, error: errorCode, messageCode, message });
}

async function resolveNutritionistId(db, nutritionistUserId) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError('NUTRITIONIST_NOT_FOUND', 'nutritionist.notFound', 'Nutritionist profile not found.', 404);
  }

  return nutritionist.id;
}

async function resolveMeal(db, nutritionistId, mealId) {
  const meal = await db.dietMeal.findUnique({
    where: { id: mealId },
    include: {
      protocol: { select: { nutritionistId: true, deletedAt: true } },
    },
  });

  if (!meal || meal.deletedAt) {
    throw buildDietError(DietErrorCode.MEAL_NOT_FOUND, DietMessageCode.MEAL_NOT_FOUND, 'Meal not found.', 404);
  }

  if (!meal.protocol || meal.protocol.deletedAt || meal.protocol.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this meal.',
      403,
    );
  }

  return meal;
}

async function buildFoodSnapshot(db, foodId, quantityG, overrides = {}) {
  if (!foodId) {
    return {
      energyKcal: overrides.energyKcal ?? null,
      proteinG: overrides.proteinG ?? null,
      carbohydratesG: overrides.carbohydratesG ?? null,
      totalFatG: overrides.totalFatG ?? null,
      fiberG: overrides.fiberG ?? null,
    };
  }

  const food = await db.food.findUnique({
    where: { id: foodId },
    select: { name: true, energyKcal: true, proteinG: true, carbohydratesG: true, totalFatG: true, fiberG: true },
  });

  if (!food) {
    throw new AppError({
      httpStatus: 404,
      error: DietErrorCode.FOOD_NOT_FOUND,
      messageCode: 'resource.notFound',
      message: `Food not found: ${foodId}`,
    });
  }

  const qty = Number(quantityG);
  return {
    foodName: overrides.foodName || food.name,
    energyKcal: scaleNutrient(food.energyKcal, qty),
    proteinG: scaleNutrient(food.proteinG, qty),
    carbohydratesG: scaleNutrient(food.carbohydratesG, qty),
    totalFatG: scaleNutrient(food.totalFatG, qty),
    fiberG: scaleNutrient(food.fiberG, qty),
  };
}

/**
 * Add a food item to a diet meal.
 * If foodId is provided, calculates nutritional snapshot proportionally.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} mealId - Meal UUID
 * @param {object} data - Food item data
 * @returns {Promise<object>} Created food item
 */
export async function createFoodItem(db, nutritionistUserId, mealId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);
  await resolveMeal(db, nutritionistId, mealId);

  const snapshot = await buildFoodSnapshot(db, data.foodId, data.quantityG, data);

  return db.dietFoodItem.create({
    data: {
      dietMealId: mealId,
      foodId: data.foodId || null,
      foodName: data.foodName || snapshot.foodName || 'Unknown',
      quantityG: data.quantityG,
      unit: data.unit || 'g',
      order: data.order ?? 0,
      notes: data.notes || null,
      energyKcal: snapshot.energyKcal,
      proteinG: snapshot.proteinG,
      carbohydratesG: snapshot.carbohydratesG,
      totalFatG: snapshot.totalFatG,
      fiberG: snapshot.fiberG,
    },
    include: {
      food: { select: { id: true, name: true } },
    },
  });
}

/**
 * Update a food item.
 * If quantityG changes and foodId exists, recalculates the snapshot.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} foodItemId - Food item UUID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated food item
 */
export async function updateFoodItem(db, nutritionistUserId, foodItemId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const foodItem = await db.dietFoodItem.findUnique({
    where: { id: foodItemId },
    include: {
      meal: {
        include: {
          protocol: { select: { nutritionistId: true, deletedAt: true } },
        },
      },
    },
  });

  if (!foodItem || foodItem.deletedAt) {
    throw buildDietError(
      DietErrorCode.FOOD_ITEM_NOT_FOUND,
      DietMessageCode.FOOD_ITEM_NOT_FOUND,
      'Food item not found.',
      404,
    );
  }

  if (
    !foodItem.meal?.protocol ||
    foodItem.meal.protocol.deletedAt ||
    foodItem.meal.protocol.nutritionistId !== nutritionistId
  ) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this food item.',
      403,
    );
  }

  const updateData = {};
  if (data.foodName !== undefined) updateData.foodName = data.foodName;
  if (data.unit !== undefined) updateData.unit = data.unit;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.notes !== undefined) updateData.notes = data.notes;

  if (data.quantityG !== undefined) {
    updateData.quantityG = data.quantityG;

    const effectiveFoodId = data.foodId !== undefined ? data.foodId : foodItem.foodId;
    if (effectiveFoodId) {
      const snapshot = await buildFoodSnapshot(db, effectiveFoodId, data.quantityG, data);
      updateData.energyKcal = snapshot.energyKcal;
      updateData.proteinG = snapshot.proteinG;
      updateData.carbohydratesG = snapshot.carbohydratesG;
      updateData.totalFatG = snapshot.totalFatG;
      updateData.fiberG = snapshot.fiberG;
    }
  }

  if (data.foodId !== undefined) updateData.foodId = data.foodId;
  if (data.energyKcal !== undefined && updateData.energyKcal === undefined) updateData.energyKcal = data.energyKcal;
  if (data.proteinG !== undefined && updateData.proteinG === undefined) updateData.proteinG = data.proteinG;
  if (data.carbohydratesG !== undefined && updateData.carbohydratesG === undefined) updateData.carbohydratesG = data.carbohydratesG;
  if (data.totalFatG !== undefined && updateData.totalFatG === undefined) updateData.totalFatG = data.totalFatG;
  if (data.fiberG !== undefined && updateData.fiberG === undefined) updateData.fiberG = data.fiberG;

  return db.dietFoodItem.update({
    where: { id: foodItemId },
    data: updateData,
    include: {
      food: { select: { id: true, name: true } },
    },
  });
}

/**
 * Soft-delete a food item.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} foodItemId - Food item UUID
 * @returns {Promise<object>} Deleted food item
 */
export async function deleteFoodItem(db, nutritionistUserId, foodItemId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const foodItem = await db.dietFoodItem.findUnique({
    where: { id: foodItemId },
    include: {
      meal: {
        include: {
          protocol: { select: { nutritionistId: true, deletedAt: true } },
        },
      },
    },
  });

  if (!foodItem || foodItem.deletedAt) {
    throw buildDietError(
      DietErrorCode.FOOD_ITEM_NOT_FOUND,
      DietMessageCode.FOOD_ITEM_NOT_FOUND,
      'Food item not found.',
      404,
    );
  }

  if (
    !foodItem.meal?.protocol ||
    foodItem.meal.protocol.deletedAt ||
    foodItem.meal.protocol.nutritionistId !== nutritionistId
  ) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this food item.',
      403,
    );
  }

  return db.dietFoodItem.update({
    where: { id: foodItemId },
    data: { deletedAt: new Date() },
  });
}

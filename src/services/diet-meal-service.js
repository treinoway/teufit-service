import { AppError } from '../errors/app-error.js';
import { DietErrorCode, DietMessageCode } from '../constants/diet.js';

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

async function resolveProtocol(db, nutritionistId, protocolId) {
  const protocol = await db.dietProtocol.findUnique({
    where: { id: protocolId },
    select: { id: true, nutritionistId: true, deletedAt: true },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildDietError(
      DietErrorCode.PROTOCOL_NOT_FOUND,
      DietMessageCode.PROTOCOL_NOT_FOUND,
      'Diet protocol not found.',
      404,
    );
  }

  if (protocol.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      DietMessageCode.FORBIDDEN_NOT_PROTOCOL_OWNER,
      'You do not own this protocol.',
      403,
    );
  }

  return protocol;
}

/**
 * Create a new meal in a diet protocol.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} protocolId - Protocol UUID
 * @param {object} data - Meal data
 * @returns {Promise<object>} Created meal
 */
export async function createMeal(db, nutritionistUserId, protocolId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);
  await resolveProtocol(db, nutritionistId, protocolId);

  return db.dietMeal.create({
    data: {
      dietProtocolId: protocolId,
      name: data.name,
      mealType: data.mealType,
      order: data.order ?? 0,
      scheduledTime: data.scheduledTime || null,
      notes: data.notes || null,
    },
    include: {
      foodItems: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });
}

/**
 * Update a meal.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} mealId - Meal UUID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated meal
 */
export async function updateMeal(db, nutritionistUserId, mealId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

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

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.mealType !== undefined) updateData.mealType = data.mealType;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.scheduledTime !== undefined) updateData.scheduledTime = data.scheduledTime;
  if (data.notes !== undefined) updateData.notes = data.notes;

  return db.dietMeal.update({
    where: { id: mealId },
    data: updateData,
    include: {
      foodItems: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });
}

/**
 * Soft-delete a meal.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} mealId - Meal UUID
 * @returns {Promise<object>} Deleted meal
 */
export async function deleteMeal(db, nutritionistUserId, mealId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

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

  return db.dietMeal.update({
    where: { id: mealId },
    data: { deletedAt: new Date() },
  });
}

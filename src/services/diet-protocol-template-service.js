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

function buildMealCreateData(meal, templateId) {
  return {
    dietProtocolTemplateId: templateId,
    name: meal.name,
    mealType: meal.mealType,
    order: meal.order ?? 0,
    scheduledTime: meal.scheduledTime || null,
    notes: meal.notes || null,
  };
}

/**
 * Create a new diet protocol template with optional nested meals and food items.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {object} data - Template data
 * @returns {Promise<object>} Created template
 */
export async function createTemplate(db, nutritionistUserId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  return db.$transaction(async (tx) => {
    const template = await tx.dietProtocolTemplate.create({
      data: {
        nutritionistId,
        name: data.name,
        description: data.description || null,
        dietType: data.dietType || null,
        goalType: data.goalType || null,
      },
    });

    if (data.meals && data.meals.length > 0) {
      for (const meal of data.meals) {
        const createdMeal = await tx.dietTemplateMeal.create({
          data: buildMealCreateData(meal, template.id),
        });

        if (meal.foodItems && meal.foodItems.length > 0) {
          for (const item of meal.foodItems) {
            const foodSnapshot = await buildFoodSnapshot(tx, item);
            await tx.dietTemplateFoodItem.create({
              data: {
                dietTemplateMealId: createdMeal.id,
                foodId: item.foodId || null,
                foodName: item.foodName || foodSnapshot.foodName,
                quantityG: item.quantityG,
                unit: item.unit || 'g',
                order: item.order ?? 0,
                notes: item.notes || null,
                energyKcal: foodSnapshot.energyKcal,
                proteinG: foodSnapshot.proteinG,
                carbohydratesG: foodSnapshot.carbohydratesG,
                totalFatG: foodSnapshot.totalFatG,
                fiberG: foodSnapshot.fiberG,
              },
            });
          }
        }
      }
    }

    return tx.dietProtocolTemplate.findUnique({
      where: { id: template.id },
      include: {
        meals: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          include: {
            foodItems: {
              where: { deletedAt: null },
              orderBy: { order: 'asc' },
            },
          },
        },
        _count: { select: { meals: { where: { deletedAt: null } } } },
      },
    });
  });
}

/**
 * Build nutrition snapshot for a food item given its foodId and quantityG.
 */
async function buildFoodSnapshot(db, item) {
  if (!item.foodId) {
    return {
      foodName: item.foodName || 'Unknown',
      energyKcal: item.energyKcal ?? null,
      proteinG: item.proteinG ?? null,
      carbohydratesG: item.carbohydratesG ?? null,
      totalFatG: item.totalFatG ?? null,
      fiberG: item.fiberG ?? null,
    };
  }

  const food = await db.food.findUnique({
    where: { id: item.foodId },
    select: { name: true, energyKcal: true, proteinG: true, carbohydratesG: true, totalFatG: true, fiberG: true },
  });

  if (!food) {
    throw new AppError({
      httpStatus: 404,
      error: 'FOOD_NOT_FOUND',
      messageCode: 'resource.notFound',
      message: `Food not found: ${item.foodId}`,
    });
  }

  const qty = Number(item.quantityG);
  return {
    foodName: item.foodName || food.name,
    energyKcal: scaleNutrient(food.energyKcal, qty),
    proteinG: scaleNutrient(food.proteinG, qty),
    carbohydratesG: scaleNutrient(food.carbohydratesG, qty),
    totalFatG: scaleNutrient(food.totalFatG, qty),
    fiberG: scaleNutrient(food.fiberG, qty),
  };
}

/**
 * List all active diet protocol templates for a nutritionist.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @returns {Promise<object[]>} List of templates with meal count
 */
export async function listTemplates(db, nutritionistUserId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const templates = await db.dietProtocolTemplate.findMany({
    where: { nutritionistId, deletedAt: null },
    include: {
      _count: { select: { meals: { where: { deletedAt: null } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return templates.map(({ _count, ...tpl }) => ({
    ...tpl,
    mealsCount: _count.meals,
  }));
}

/**
 * Get a single diet protocol template by ID.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} templateId - Template UUID
 * @returns {Promise<object>} Template with meals and food items
 */
export async function getTemplateById(db, nutritionistUserId, templateId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const template = await db.dietProtocolTemplate.findUnique({
    where: { id: templateId },
    include: {
      meals: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          foodItems: {
            where: { deletedAt: null },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildDietError(
      DietErrorCode.TEMPLATE_NOT_FOUND,
      DietMessageCode.TEMPLATE_NOT_FOUND,
      'Diet template not found.',
      404,
    );
  }

  if (template.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      DietMessageCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      'You do not have permission to access this template.',
      403,
    );
  }

  return template;
}

/**
 * Update a diet protocol template.
 * If `meals` is provided, all existing meals (and food items) are replaced.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} templateId - Template UUID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated template
 */
export async function updateTemplate(db, nutritionistUserId, templateId, data) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const template = await db.dietProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildDietError(
      DietErrorCode.TEMPLATE_NOT_FOUND,
      DietMessageCode.TEMPLATE_NOT_FOUND,
      'Diet template not found.',
      404,
    );
  }

  if (template.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      DietMessageCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      'You do not have permission to modify this template.',
      403,
    );
  }

  return db.$transaction(async (tx) => {
    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.dietType !== undefined) updateData.dietType = data.dietType;
    if (data.goalType !== undefined) updateData.goalType = data.goalType;

    await tx.dietProtocolTemplate.update({ where: { id: templateId }, data: updateData });

    if (data.meals !== undefined) {
      await tx.dietTemplateFoodItem.deleteMany({
        where: { meal: { dietProtocolTemplateId: templateId } },
      });
      await tx.dietTemplateMeal.deleteMany({ where: { dietProtocolTemplateId: templateId } });

      for (const meal of data.meals) {
        const createdMeal = await tx.dietTemplateMeal.create({
          data: buildMealCreateData(meal, templateId),
        });

        if (meal.foodItems && meal.foodItems.length > 0) {
          for (const item of meal.foodItems) {
            const foodSnapshot = await buildFoodSnapshot(tx, item);
            await tx.dietTemplateFoodItem.create({
              data: {
                dietTemplateMealId: createdMeal.id,
                foodId: item.foodId || null,
                foodName: item.foodName || foodSnapshot.foodName,
                quantityG: item.quantityG,
                unit: item.unit || 'g',
                order: item.order ?? 0,
                notes: item.notes || null,
                energyKcal: foodSnapshot.energyKcal,
                proteinG: foodSnapshot.proteinG,
                carbohydratesG: foodSnapshot.carbohydratesG,
                totalFatG: foodSnapshot.totalFatG,
                fiberG: foodSnapshot.fiberG,
              },
            });
          }
        }
      }
    }

    return tx.dietProtocolTemplate.findUnique({
      where: { id: templateId },
      include: {
        meals: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          include: {
            foodItems: {
              where: { deletedAt: null },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });
  });
}

/**
 * Soft-delete a diet protocol template.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} templateId - Template UUID
 * @returns {Promise<object>} Deleted template
 */
export async function deleteTemplate(db, nutritionistUserId, templateId) {
  const nutritionistId = await resolveNutritionistId(db, nutritionistUserId);

  const template = await db.dietProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildDietError(
      DietErrorCode.TEMPLATE_NOT_FOUND,
      DietMessageCode.TEMPLATE_NOT_FOUND,
      'Diet template not found.',
      404,
    );
  }

  if (template.nutritionistId !== nutritionistId) {
    throw buildDietError(
      DietErrorCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      DietMessageCode.FORBIDDEN_NOT_TEMPLATE_OWNER,
      'You do not have permission to delete this template.',
      403,
    );
  }

  return db.dietProtocolTemplate.update({
    where: { id: templateId },
    data: { deletedAt: new Date() },
  });
}

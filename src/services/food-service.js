import { AppError } from '../errors/app-error.js';
import { DietErrorCode } from '../constants/diet.js';

/**
 * Search foods by name (case-insensitive) with optional group filter.
 *
 * @param {object} db - Prisma client
 * @param {{ query?: string, groupId?: string, limit?: number, offset?: number }} params
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function searchFoods(db, { query, groupId, source = 'taco', limit = 20, offset = 0 } = {}) {
  const where = {};

  if (query) {
    where.name = { contains: query, mode: 'insensitive' };
  }

  if (groupId) {
    where.foodGroupId = groupId;
  }

  if (source) {
    where.source = source;
  }

  const [items, total] = await db.$transaction([
    db.food.findMany({
      where,
      include: {
        foodGroup: { select: { id: true, name: true, code: true } },
      },
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    }),
    db.food.count({ where }),
  ]);

  return { items, total };
}

/**
 * Get a single food by ID.
 *
 * @param {object} db - Prisma client
 * @param {string} foodId - Food UUID
 * @returns {Promise<object>} Food record
 */
export async function getFoodById(db, foodId) {
  const food = await db.food.findUnique({
    where: { id: foodId },
    include: {
      foodGroup: { select: { id: true, name: true, code: true } },
    },
  });

  if (!food) {
    throw new AppError({
      httpStatus: 404,
      error: DietErrorCode.FOOD_NOT_FOUND,
      messageCode: 'resource.notFound',
      message: 'Food not found.',
    });
  }

  return food;
}

/**
 * List all food groups.
 *
 * @param {object} db - Prisma client
 * @returns {Promise<object[]>} List of food groups
 */
export async function listFoodGroups(db) {
  return db.foodGroup.findMany({
    orderBy: { name: 'asc' },
  });
}

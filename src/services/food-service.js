import { Prisma } from '@prisma/client';
import { NotFoundAppError } from '../errors/app-error.js';
import { escapeLike, tokenize, buildRelevanceOrder } from '../helpers/food-search-ranking.js';
import { toFoodDto, foodColumns } from '../helpers/nutrition-food.js';
import {
  FoodSource,
  foodSourceValues,
  FOOD_SEARCH_LIMIT_DEFAULT,
  FOOD_SEARCH_LIMIT_MAX,
  NutritionErrorCode,
  NutritionMessageCode,
} from '../constants/nutrition.js';

const GROUP_INCLUDE = { foodGroup: { select: { id: true, name: true } } };

// SQL visibility rule: requested public sources plus the caller's own custom foods.
function buildSourceCondition({ sources, nutritionistId }) {
  const publicSources = sources.filter((source) => source !== FoodSource.CUSTOM);
  const clauses = [];
  if (publicSources.length > 0) {
    clauses.push(Prisma.sql`(f.nutritionist_id IS NULL AND f.source IN (${Prisma.join(publicSources)}))`);
  }
  if (sources.includes(FoodSource.CUSTOM) && nutritionistId) {
    clauses.push(Prisma.sql`(f.nutritionist_id = ${nutritionistId}::uuid)`);
  }
  return clauses.length > 0 ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})` : null;
}

// SQL condition for one accent- and case-insensitive token.
function buildTokenCondition(token) {
  return Prisma.sql`unaccent(lower(f.name)) LIKE unaccent(lower(${`%${escapeLike(token)}%`}))`;
}

// Clamps the requested limit.
function clampLimit(limit) {
  if (!Number.isFinite(limit) || limit < 1) return FOOD_SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.floor(limit), FOOD_SEARCH_LIMIT_MAX);
}

// Selects the ordered ids matching the search.
function selectMatchingIds(db, { sourceCondition, query, groupId, limit }) {
  const conditions = [sourceCondition, ...tokenize(query).map(buildTokenCondition)];
  if (groupId) conditions.push(Prisma.sql`f.food_group_id = ${groupId}::uuid`);
  return db.$queryRaw`
    SELECT f.id FROM foods f
    WHERE ${Prisma.join(conditions, ' AND ')}
    ${buildRelevanceOrder(query)}
    LIMIT ${limit}`;
}

/**
 * Searches foods across TACO, TBCA and the caller's own custom foods (accent/case-insensitive).
 *
 * @returns {Promise<{ items: object[] }>}
 */
export async function searchFoods(db, { nutritionistId = null, query, groupId, sources = foodSourceValues, limit } = {}) {
  const sourceCondition = buildSourceCondition({ sources, nutritionistId });
  if (!sourceCondition) return { items: [] };

  const rows = await selectMatchingIds(db, { sourceCondition, query, groupId, limit: clampLimit(limit) });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { items: [] };

  const foods = await db.food.findMany({ where: { id: { in: ids } }, include: GROUP_INCLUDE });
  const foodById = new Map(foods.map((food) => [food.id, food]));
  return { items: ids.map((id) => toFoodDto(foodById.get(id))) };
}

// Builds the food-not-found error.
function foodNotFound() {
  return new NotFoundAppError({
    error: NutritionErrorCode.FOOD_NOT_FOUND,
    messageCode: NutritionMessageCode.FOOD_NOT_FOUND,
    message: 'Food not found.',
  });
}

/**
 * Food row visible to the caller (public or own custom food) or 404.
 */
export async function requireAccessibleFood(db, { nutritionistId = null, foodId }) {
  const food = await db.food.findFirst({
    where: { id: foodId, OR: [{ nutritionistId: null }, ...(nutritionistId ? [{ nutritionistId }] : [])] },
    include: GROUP_INCLUDE,
  });
  if (!food) throw foodNotFound();
  return food;
}

/**
 * One food in the Food contract shape.
 */
export async function getFoodById(db, { nutritionistId = null, foodId }) {
  return toFoodDto(await requireAccessibleFood(db, { nutritionistId, foodId }));
}

/**
 * All food groups ordered by name.
 */
export async function listFoodGroups(db) {
  const groups = await db.foodGroup.findMany({ orderBy: { name: 'asc' } });
  return { items: groups.map(({ id, name, code }) => ({ id, name, code })) };
}

// Throws 404 when the food group does not exist.
async function assertFoodGroupExists(db, groupId) {
  const group = await db.foodGroup.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!group) {
    throw new NotFoundAppError({
      error: NutritionErrorCode.FOOD_GROUP_NOT_FOUND,
      messageCode: NutritionMessageCode.FOOD_GROUP_NOT_FOUND,
      message: 'Food group not found.',
    });
  }
}

/**
 * Creates a custom food ("Meus alimentos") owned by the nutritionist.
 */
export async function createCustomFood(db, { nutritionistId, data }) {
  await assertFoodGroupExists(db, data.groupId);
  const food = await db.food.create({
    data: {
      nutritionistId,
      foodGroupId: data.groupId,
      name: data.name,
      source: FoodSource.CUSTOM,
      ...foodColumns(data),
    },
    include: GROUP_INCLUDE,
  });
  return toFoodDto(food);
}

// Loads a custom food owned by the nutritionist or throws 404.
async function requireOwnedCustomFood(db, { nutritionistId, foodId }) {
  const food = await db.food.findFirst({ where: { id: foodId, nutritionistId } });
  if (!food) throw foodNotFound();
  return food;
}

/**
 * Updates an owned custom food (partial).
 */
export async function updateCustomFood(db, { nutritionistId, foodId, data }) {
  await requireOwnedCustomFood(db, { nutritionistId, foodId });
  if (data.groupId) await assertFoodGroupExists(db, data.groupId);
  const food = await db.food.update({
    where: { id: foodId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.groupId !== undefined && { foodGroupId: data.groupId }),
      ...foodColumns(data),
    },
    include: GROUP_INCLUDE,
  });
  return toFoodDto(food);
}

/**
 * Deletes an owned custom food (plan items keep their snapshot).
 */
export async function deleteCustomFood(db, { nutritionistId, foodId }) {
  await requireOwnedCustomFood(db, { nutritionistId, foodId });
  await db.food.delete({ where: { id: foodId } });
}

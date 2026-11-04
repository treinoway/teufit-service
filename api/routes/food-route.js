import { prisma } from '../../src/db.js';
import { authenticate } from '../middleware/auth.js';
import { findNutritionistId } from '../middleware/nutritionist.js';
import * as service from '../../src/services/food-service.js';
import { foodSourceValues } from '../../src/constants/nutrition.js';
import * as schema from '../schemas/food-route.schema.js';

// Parses the comma separated sources query (unknown values are dropped; absent means all).
function parseSources(sources) {
  if (sources === undefined) return foodSourceValues;
  return sources.split(',').map((source) => source.trim()).filter((source) => foodSourceValues.includes(source));
}

// Registers the food search and food group routes.
export async function foodRoutes(fastify) {
  fastify.get('/foods', { preHandler: [authenticate], schema: schema.searchFoodsSchema }, async (request) => {
    const { q, groupId, sources, limit } = request.query;
    const nutritionistId = await findNutritionistId(request.user.id);
    return service.searchFoods(prisma, { nutritionistId, query: q, groupId, sources: parseSources(sources), limit });
  });

  fastify.get('/foods/:id', { preHandler: [authenticate], schema: schema.getFoodByIdSchema }, async (request) => {
    const nutritionistId = await findNutritionistId(request.user.id);
    return service.getFoodById(prisma, { nutritionistId, foodId: request.params.id });
  });

  fastify.get('/food-groups', { preHandler: [authenticate], schema: schema.listFoodGroupsSchema }, () =>
    service.listFoodGroups(prisma));
}

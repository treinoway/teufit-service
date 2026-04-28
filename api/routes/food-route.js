import { authenticate } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/food-service.js';
import * as schema from '../schemas/food-route.schema.js';
import config from '../../config/index.js';

export async function foodRoutes(fastify) {
  // GET /foods — search foods
  fastify.get(
    '/foods',
    {
      config: { rateLimit: config.rateLimit.food.search },
      preHandler: [authenticate],
      schema: schema.searchFoodsSchema,
    },
    async (request, reply) => {
      const { q, groupId, source, limit, offset } = request.query;
      const result = await service.searchFoods(prisma, {
        query: q,
        groupId,
        source: source ?? 'taco',
        limit: limit ? Number(limit) : 20,
        offset: offset ? Number(offset) : 0,
      });
      return reply.send(result);
    },
  );

  // GET /foods/:id — get food by ID
  fastify.get(
    '/foods/:id',
    {
      config: { rateLimit: config.rateLimit.food.getById },
      preHandler: [authenticate],
      schema: schema.getFoodByIdSchema,
    },
    async (request, reply) => {
      const food = await service.getFoodById(prisma, request.params.id);
      return reply.send(food);
    },
  );

  // GET /food-groups — list all food groups
  fastify.get(
    '/food-groups',
    {
      config: { rateLimit: config.rateLimit.food.groups },
      preHandler: [authenticate],
      schema: schema.listFoodGroupsSchema,
    },
    async (request, reply) => {
      const groups = await service.listFoodGroups(prisma);
      return reply.send(groups);
    },
  );
}

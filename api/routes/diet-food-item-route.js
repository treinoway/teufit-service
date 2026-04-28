import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/diet-food-item-service.js';
import * as schema from '../schemas/diet-food-item-route.schema.js';
import config from '../../config/index.js';

export async function dietFoodItemRoutes(fastify) {
  // POST /nutritionist/meals/:mealId/food-items
  fastify.post(
    '/nutritionist/meals/:mealId/food-items',
    {
      config: { rateLimit: config.rateLimit.dietFoodItem.create },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.createFoodItemSchema,
    },
    async (request, reply) => {
      const item = await service.createFoodItem(prisma, request.user.id, request.params.mealId, request.body);
      return reply.status(201).send(item);
    },
  );

  // PATCH /nutritionist/food-items/:foodItemId
  fastify.patch(
    '/nutritionist/food-items/:foodItemId',
    {
      config: { rateLimit: config.rateLimit.dietFoodItem.update },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.updateFoodItemSchema,
    },
    async (request, reply) => {
      const item = await service.updateFoodItem(prisma, request.user.id, request.params.foodItemId, request.body);
      return reply.send(item);
    },
  );

  // DELETE /nutritionist/food-items/:foodItemId
  fastify.delete(
    '/nutritionist/food-items/:foodItemId',
    {
      config: { rateLimit: config.rateLimit.dietFoodItem.delete },
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.deleteFoodItemSchema,
    },
    async (request, reply) => {
      const result = await service.deleteFoodItem(prisma, request.user.id, request.params.foodItemId);
      return reply.send(result);
    },
  );
}

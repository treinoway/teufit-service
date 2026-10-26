import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/diet-meal-service.js';
import * as schema from '../schemas/diet-meal-route.schema.js';

export async function dietMealRoutes(fastify) {
  // POST /nutritionist/diet-protocols/:protocolId/meals
  fastify.post(
    '/nutritionist/diet-protocols/:protocolId/meals',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.createMealSchema,
    },
    async (request, reply) => {
      const meal = await service.createMeal(prisma, request.user.id, request.params.protocolId, request.body);
      return reply.status(201).send(meal);
    },
  );

  // PATCH /nutritionist/meals/:mealId
  fastify.patch(
    '/nutritionist/meals/:mealId',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.updateMealSchema,
    },
    async (request, reply) => {
      const meal = await service.updateMeal(prisma, request.user.id, request.params.mealId, request.body);
      return reply.send(meal);
    },
  );

  // DELETE /nutritionist/meals/:mealId
  fastify.delete(
    '/nutritionist/meals/:mealId',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.deleteMealSchema,
    },
    async (request, reply) => {
      const result = await service.deleteMeal(prisma, request.user.id, request.params.mealId);
      return reply.send(result);
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { patch, getOneByUserId, listNutritionists } from '../../src/services/nutritionist-service.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getNutritionistSchema,
  updateNutritionistSchema,
  listNutritionistsSchema,
} from '../schemas/nutritionist-route.schema.js';

/**
 * Nutritionist resource routes.
 *
 * - GET /nutritionists: public listing of nutritionists with completed profiles
 * - GET /nutritionist: get the authenticated nutritionist's own profile
 * - PATCH /nutritionist: update the authenticated nutritionist's profile
 */
export async function nutritionistRoutes(fastify) {

  fastify.get(
    '/nutritionists',
    {
      preHandler: [authenticate],
      schema: listNutritionistsSchema,
    },
    async (_request, reply) => {
      const nutritionists = await listNutritionists();
      return reply.send(nutritionists);
    },
  );

  fastify.get(
    '/nutritionist',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: getNutritionistSchema,
    },
    async (request, reply) => {
      const profile = await getOneByUserId(request.user.id);
      return reply.send(profile);
    },
  );

  fastify.patch(
    '/nutritionist',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: updateNutritionistSchema,
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const { nutritionist } = body;

      const updated = await patch({
        userId: request.user.id,
        nutritionist,
      });

      return reply.send(updated);
    },
  );
}

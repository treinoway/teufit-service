/**
 * Trainer Dashboard Route
 *
 * GET /trainer/dashboard — aggregated "Torre de Controle" KPIs for the
 * trainer Home screen (plans, routines, finance, engagement).
 *
 * Auth: authenticate + requireRole(TRAINER)
 */

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getTrainerDashboard } from '../../src/services/trainer-dashboard-service.js';
import { getTrainerDashboardSchema } from '../schemas/trainer-dashboard-route.schema.js';
import { prisma } from '../../src/db.js';

export async function trainerDashboardRoutes(fastify) {
  fastify.get(
    '/trainer/dashboard',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getTrainerDashboardSchema,
    },
    async (request, reply) => {
      const dashboard = await getTrainerDashboard(prisma, request.user.id);
      return reply.send(dashboard);
    },
  );
}

import { authenticate, requireAdmin } from '../middleware/auth.js';
import { listTrainers, setTrainerTier } from '../../src/services/admin-trainer-service.js';
import * as schema from '../schemas/admin-trainer-route.schema.js';
import { prisma } from '../../src/db.js';

// Registers admin-only trainer listing and plan override routes.
export async function adminTrainerRoutes(fastify) {
  fastify.get(
    '/admin/trainers',
    {
      preHandler: [authenticate, requireAdmin()],
      schema: schema.listTrainersSchema,
    },
    async (request, reply) => {
      const { search, page, pageSize, includeSignups, inviteStatus } = request.query;
      return reply.send(await listTrainers(prisma, { search, page, pageSize, includeSignups, inviteStatus }));
    },
  );

  fastify.patch(
    '/admin/trainers/:trainerId/platform-plan',
    {
      preHandler: [authenticate, requireAdmin()],
      schema: schema.setTrainerPlanSchema,
    },
    async (request, reply) => {
      const { trainerId } = request.params;
      const { tier } = request.body;
      return reply.send(await setTrainerTier(prisma, { trainerId, tier }));
    },
  );
}

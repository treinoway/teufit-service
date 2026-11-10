/**
 * Consistency Ranking Routes (admin)
 *
 * GET /admin/consistency-ranking/trainers/:trainerId/standings
 *
 * Auth: authenticate + requireAdmin()
 */

import { NotFoundAppError } from '../../src/errors/app-error.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { adminGetStandingsSchema } from '../schemas/consistency-ranking-route.schema.js';
import { buildStandingsPayload } from './consistency-ranking-route.js';
import { prisma } from '../../src/db.js';

// 404 unless the trainer exists and is neither soft-deleted nor owned by a soft-deleted user
async function assertTrainerExists(trainerId) {
  const trainer = await prisma.trainer.findUnique({
    where: { id: trainerId },
    select: { deletedAt: true, user: { select: { deletedAt: true } } },
  });
  if (!trainer || trainer.deletedAt || trainer.user?.deletedAt) {
    throw new NotFoundAppError({ message: 'Trainer not found', details: {} });
  }
}

// Route plugin registering the admin consistency ranking endpoint
export async function adminConsistencyRankingRoutes(fastify) {
  fastify.get(
    '/admin/consistency-ranking/trainers/:trainerId/standings',
    { preHandler: [authenticate, requireAdmin()], schema: adminGetStandingsSchema },
    async (request, reply) => {
      const { trainerId } = request.params;
      await assertTrainerExists(trainerId);
      return reply.send(await buildStandingsPayload(trainerId, request.query.season));
    },
  );
}

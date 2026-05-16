/**
 * Trainer Briefing Routes
 *
 * GET /trainer/briefing — returns the trainer's KPI snapshot for the
 * "SEUS ALUNOS AGORA" card in the AI assistant view.
 *
 * Auth: authenticate + requireRole(TRAINER)
 */

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getBriefing } from '../../src/services/briefing-service.js';
import { getBriefingSchema } from '../schemas/trainer-briefing-route.schema.js';
import { prisma } from '../../src/db.js';

export async function trainerBriefingRoutes(fastify) {
  fastify.get(
    '/trainer/briefing',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getBriefingSchema,
    },
    async (request, reply) => {
      const briefing = await getBriefing(prisma, request.user.id);
      return reply.send(briefing);
    },
  );
}

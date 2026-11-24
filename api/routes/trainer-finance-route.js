/**
 * Trainer Finance Route
 *
 * GET /trainer/finance/overview — KPIs + payment rows for the Financeiro page
 * in a single call (no per-student requests).
 *
 * Auth: authenticate + requireRole(TRAINER)
 */

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getFinanceOverview, getFinanceSummary } from '../../src/services/trainer-finance-service.js';
import { resolveTrainerOwnerOrThrow } from '../../src/services/professional-owner-service.js';
import { getFinanceOverviewSchema } from '../schemas/trainer-finance-route.schema.js';
import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';

/**
 * Registers the finance overview (and, when a summary schema is given, the summary) under a prefix.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ prefix: string, preHandler: Function[], resolveOwner: Function, schemas: object }} config
 */
export function registerFinanceRoutes(fastify, { prefix, preHandler, resolveOwner, schemas }) {
  fastify.get(
    `${prefix}/finance/overview`,
    { preHandler, schema: schemas.getFinanceOverview },
    async (request, reply) => {
      const owner = await resolveOwner(prisma, request.user.id);
      const overview = await getFinanceOverview(
        prisma,
        owner,
        { month: request.query.month },
        { logger: request.log, resolveAvatarUrl: (stored) => s3BucketHandler.resolveUrl(stored) },
      );
      return reply.send(overview);
    },
  );

  if (schemas.getFinanceSummary) {
    fastify.get(
      `${prefix}/finance/summary`,
      { preHandler, schema: schemas.getFinanceSummary },
      async (request, reply) => {
        const owner = await resolveOwner(prisma, request.user.id);
        return reply.send(await getFinanceSummary(prisma, owner));
      },
    );
  }
}

// Registers the trainer-only /trainer/finance/overview route.
export async function trainerFinanceRoutes(fastify) {
  registerFinanceRoutes(fastify, {
    prefix: '/trainer',
    preHandler: [authenticate, requireRole(Roles.TRAINER)],
    resolveOwner: resolveTrainerOwnerOrThrow,
    schemas: { getFinanceOverview: getFinanceOverviewSchema },
  });
}

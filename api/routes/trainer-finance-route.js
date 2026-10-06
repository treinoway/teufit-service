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
import { getFinanceOverview } from '../../src/services/trainer-finance-service.js';
import { getFinanceOverviewSchema } from '../schemas/trainer-finance-route.schema.js';
import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import config from '../../config/index.js';

export async function trainerFinanceRoutes(fastify) {
  fastify.get(
    '/trainer/finance/overview',
    {
      config: { rateLimit: config.rateLimit.trainerFinance.overview },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getFinanceOverviewSchema,
    },
    async (request, reply) => {
      const overview = await getFinanceOverview(
        prisma,
        request.user.id,
        { month: request.query.month },
        { logger: request.log, resolveAvatarUrl: (stored) => s3BucketHandler.resolveUrl(stored) },
      );
      return reply.send(overview);
    },
  );
}

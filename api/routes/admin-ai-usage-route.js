import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getAiUsageByMonth } from '../../src/services/admin-ai-usage-service.js';
import * as schema from '../schemas/admin-ai-usage-route.schema.js';
import { prisma } from '../../src/db.js';

// Registers the admin-only iArnold token usage route.
export async function adminAiUsageRoutes(fastify) {
  fastify.get(
    '/admin/ai-usage',
    {
      preHandler: [authenticate, requireAdmin()],
      schema: schema.getAiUsageSchema,
    },
    async (request, reply) => {
      return reply.send(await getAiUsageByMonth(prisma, { month: request.query.month }));
    },
  );
}

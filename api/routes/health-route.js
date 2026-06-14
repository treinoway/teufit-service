import { prisma } from '../../src/db.js';
import { getHealthStatus } from '../../src/services/health-service.js';
import { getHealthSchema } from '../schemas/health-route.schema.js';

export async function healthRoutes(fastify) {
  // GET /health — public, no auth. Polled by external uptime monitors.
  fastify.get(
    '/health',
    { schema: getHealthSchema },
    async (_request, reply) => {
      const payload = await getHealthStatus(prisma);
      const httpStatus = payload.status === 'ok' ? 200 : 503;
      return reply.status(httpStatus).send(payload);
    },
  );
}

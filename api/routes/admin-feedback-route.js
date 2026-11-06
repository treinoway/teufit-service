import { authenticate, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import { listFeedbacks, updateFeedbackStatus } from '../../src/services/trainer-feedback-service.js';
import { listFeedbacksSchema, updateFeedbackStatusSchema } from '../schemas/trainer-feedback-route.schema.js';

const adminOnly = [authenticate, requireAdmin()];

// Registers the admin-only trainer feedback routes.
export async function adminFeedbackRoutes(fastify) {
  fastify.get('/admin/feedbacks', { preHandler: adminOnly, schema: listFeedbacksSchema }, async (request, reply) => {
    const { status, category, page, pageSize } = request.query;
    return reply.send(await listFeedbacks(prisma, { status, category, page, pageSize }));
  });

  fastify.patch(
    '/admin/feedbacks/:id',
    { preHandler: adminOnly, schema: updateFeedbackStatusSchema },
    async (request, reply) => {
      return reply.send(await updateFeedbackStatus(prisma, request.params.id, request.body.status));
    },
  );
}

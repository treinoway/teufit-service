import config from '../../config/index.js';
import { authenticate, requireTrainer } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import { createFeedback } from '../../src/services/trainer-feedback-service.js';
import { createFeedbackSchema } from '../schemas/trainer-feedback-route.schema.js';

// Registers the trainer-facing beta feedback route.
export async function trainerFeedbackRoutes(fastify) {
  fastify.post(
    '/trainer/feedback',
    {
      config: { rateLimit: config.rateLimit.feedback.create },
      preHandler: [authenticate, requireTrainer()],
      schema: createFeedbackSchema,
    },
    async (request, reply) => {
      const created = await createFeedback(prisma, request.user.id, request.body, {
        userAgent: request.headers['user-agent'],
      });
      return reply.status(201).send(created);
    },
  );
}

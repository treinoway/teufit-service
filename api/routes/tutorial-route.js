import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import * as service from '../../src/services/tutorial-service.js';
import * as schema from '../schemas/tutorial-route.schema.js';

// Registers the trainer-facing tutorial listing route.
export async function tutorialRoutes(fastify) {
  fastify.get(
    '/tutorials',
    {
      preHandler: [authenticate, requireRole([Roles.TRAINER, Roles.ADMIN])],
      schema: schema.listTutorialsSchema,
    },
    async (request, reply) => {
      const items = await service.listTutorialsForTrainer(prisma, s3BucketHandler);
      return reply.send({ items });
    },
  );
}

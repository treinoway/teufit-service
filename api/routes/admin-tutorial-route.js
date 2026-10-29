import { authenticate, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import * as service from '../../src/services/tutorial-service.js';
import * as schema from '../schemas/tutorial-route.schema.js';

const adminOnly = [authenticate, requireAdmin()];

// Registers the admin-only tutorial management routes.
export async function adminTutorialRoutes(fastify) {
  fastify.post(
    '/admin/tutorials/upload-url',
    { preHandler: adminOnly, schema: schema.createUploadUrlSchema },
    async (request, reply) => {
      const result = await service.createUploadUrl(s3BucketHandler, request.body);
      return reply.send(result);
    },
  );

  fastify.patch(
    '/admin/tutorials/reorder',
    { preHandler: adminOnly, schema: schema.reorderTutorialsSchema },
    async (request, reply) => {
      const rows = await service.reorderTutorials(prisma, request.body.orderedIds);
      const items = await Promise.all(rows.map((row) => service.formatTutorialForAdmin(s3BucketHandler, row)));
      return reply.send({ items });
    },
  );

  fastify.post(
    '/admin/tutorials',
    { preHandler: adminOnly, schema: schema.createTutorialSchema },
    async (request, reply) => {
      await service.assertVideoKeyUnused(prisma, request.body);
      const row = await service.createTutorial(prisma, request.body, request.user.id);
      const tutorial = await service.formatTutorialForAdmin(s3BucketHandler, row);
      return reply.status(201).send(tutorial);
    },
  );

  fastify.get(
    '/admin/tutorials',
    { preHandler: adminOnly, schema: schema.listTutorialsAdminSchema },
    async (request, reply) => {
      const items = await service.listTutorials(prisma, s3BucketHandler);
      return reply.send({ items });
    },
  );

  fastify.get(
    '/admin/tutorials/:id',
    { preHandler: adminOnly, schema: schema.getTutorialAdminSchema },
    async (request, reply) => {
      const tutorial = await service.getTutorialById(prisma, s3BucketHandler, request.params.id);
      return reply.send(tutorial);
    },
  );

  fastify.patch(
    '/admin/tutorials/:id',
    { preHandler: adminOnly, schema: schema.updateTutorialSchema },
    async (request, reply) => {
      await service.assertVideoKeyUnused(prisma, request.body, request.params.id);
      const tutorial = await service.updateTutorial(prisma, s3BucketHandler, request.params.id, request.body);
      return reply.send(tutorial);
    },
  );

  fastify.delete(
    '/admin/tutorials/:id',
    { preHandler: adminOnly, schema: schema.deleteTutorialSchema },
    async (request, reply) => {
      await service.deleteTutorial(prisma, s3BucketHandler, request.params.id);
      return reply.status(204).send();
    },
  );
}

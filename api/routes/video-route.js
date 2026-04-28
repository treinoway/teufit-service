import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/admin-video-service.js';
import * as schema from '../schemas/video-route.schema.js';

const allowedRoles = [Roles.TRAINER, Roles.ADMIN];

export async function videoRoutes(fastify) {
  fastify.get(
    '/videos',
    {
      preHandler: [authenticate, requireRole(allowedRoles)],
      schema: schema.listVideosSchema,
    },
    async (request, reply) => {
      const result = await service.listVideos(prisma, request.query);
      return reply.send(result);
    },
  );

  fastify.get(
    '/videos/:videoId',
    {
      preHandler: [authenticate, requireRole(allowedRoles)],
      schema: schema.getVideoSchema,
    },
    async (request, reply) => {
      const video = await service.getVideoById(prisma, request.params.videoId);
      return reply.send(video);
    },
  );
}

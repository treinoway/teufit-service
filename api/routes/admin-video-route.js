import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/admin-video-service.js';
import * as schema from '../schemas/admin-video-route.schema.js';

export async function adminVideoRoutes(fastify) {
  fastify.post(
    '/admin/videos',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.createVideoSchema,
    },
    async (request, reply) => {
      const video = await service.createVideo(prisma, request.user.id, request.body);
      return reply.status(201).send(video);
    },
  );

  fastify.get(
    '/admin/videos',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.listVideosAdminSchema,
    },
    async (request, reply) => {
      const result = await service.listVideos(prisma, request.query);
      return reply.send(result);
    },
  );

  fastify.get(
    '/admin/videos/:videoId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.getVideoAdminSchema,
    },
    async (request, reply) => {
      const video = await service.getVideoById(prisma, request.params.videoId);
      return reply.send(video);
    },
  );

  fastify.patch(
    '/admin/videos/:videoId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.updateVideoSchema,
    },
    async (request, reply) => {
      const video = await service.updateVideo(prisma, request.params.videoId, request.body);
      return reply.send(video);
    },
  );

  fastify.delete(
    '/admin/videos/:videoId',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.deleteVideoSchema,
    },
    async (request, reply) => {
      const result = await service.deleteVideo(prisma, request.params.videoId);
      return reply.send(result);
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import config from '../../config/index.js';
import * as service from '../../src/services/exercise-video-service.js';
import { exerciseVideoUploadUrlSchema } from '../schemas/exercise-video.schema.js';

// Registers the trainer route that issues presigned exercise video upload URLs.
export async function exerciseVideoRoutes(fastify) {
  fastify.post(
    '/trainer/exercise-videos/upload-url',
    {
      config: { rateLimit: config.rateLimit.exerciseVideo.uploadUrl },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: exerciseVideoUploadUrlSchema,
    },
    async (request, reply) => {
      const descriptor = await service.createExerciseVideoUploadUrl(
        prisma,
        s3BucketHandler,
        request.user.id,
        request.body,
      );
      return reply.send(descriptor);
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { importPrimeCoachingPreviewSchema } from '../schemas/import-primecoaching-route.schema.js';
import { parseStudentsFromXlsx } from '../../src/services/import/primecoaching-service.js';
import { AppError } from '../../src/errors/app-error.js';
import config from '../../config/index.js';

export async function importPrimeCoachingRoutes(fastify) {
  fastify.post(
    '/trainer/import/primecoaching/preview',
    {
      config: { rateLimit: config.rateLimit.import.primecoachingPreview },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: importPrimeCoachingPreviewSchema,
    },
    async (request, reply) => {
      let fileData;
      try {
        fileData = await request.file();
      } catch {
        throw new AppError({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
          message: 'Request must be multipart/form-data with a file field',
          details: [],
        });
      }

      if (!fileData) {
        throw new AppError({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
          message: 'A file field is required',
          details: [],
        });
      }

      const buffer = await fileData.toBuffer();
      const result = parseStudentsFromXlsx(buffer);

      return reply.send(result);
    },
  );
}

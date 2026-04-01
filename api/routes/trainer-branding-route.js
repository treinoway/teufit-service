import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  upsertBranding,
  uploadBrandingImage,
  getBrandingByTrainerId,
  getStudentTrainerBranding,
} from '../../src/services/trainer-branding-service.js';
import {
  upsertBrandingSchema,
  getBrandingSchema,
  uploadBrandingImageSchema,
  getStudentTrainerBrandingSchema,
} from '../schemas/trainer-branding-route.schema.js';
import { prisma } from '../../src/db.js';
import { ConflictAppError, ValidationAppError } from '../../src/errors/app-error.js';

async function resolveTrainerRecord(userId) {
  const trainerRecord = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainerRecord) {
    throw new ConflictAppError({
      message: 'Trainer profile not found',
      messageCode: 'trainer.profileMissing',
    });
  }

  return trainerRecord;
}

export async function trainerBrandingRoutes(fastify) {
  fastify.put(
    '/trainer/branding',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: upsertBrandingSchema,
    },
    async (request, reply) => {
      const trainerRecord = await resolveTrainerRecord(request.user.id);

      const branding = await upsertBranding({
        trainerId: trainerRecord.id,
        data: request.body,
      });

      return reply.send(branding);
    },
  );

  fastify.get(
    '/trainer/branding',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getBrandingSchema,
    },
    async (request, reply) => {
      const trainerRecord = await resolveTrainerRecord(request.user.id);

      const branding = await getBrandingByTrainerId({ trainerId: trainerRecord.id });

      return reply.send(branding);
    },
  );

  fastify.post(
    '/trainer/branding/logo',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: uploadBrandingImageSchema,
    },
    async (request, reply) => {
      const trainerRecord = await resolveTrainerRecord(request.user.id);

      const fileData = await request.file();
      if (!fileData) {
        throw new ValidationAppError({
          message: 'File is required',
          details: [{ field: 'file', message: 'A file must be uploaded' }],
        });
      }

      const buffer = await fileData.toBuffer();

      const branding = await uploadBrandingImage({
        trainerId: trainerRecord.id,
        imageType: 'logo',
        file: { mimetype: fileData.mimetype, buffer },
      });

      return reply.send(branding);
    },
  );

  fastify.post(
    '/trainer/branding/cover',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: uploadBrandingImageSchema,
    },
    async (request, reply) => {
      const trainerRecord = await resolveTrainerRecord(request.user.id);

      const fileData = await request.file();
      if (!fileData) {
        throw new ValidationAppError({
          message: 'File is required',
          details: [{ field: 'file', message: 'A file must be uploaded' }],
        });
      }

      const buffer = await fileData.toBuffer();

      const branding = await uploadBrandingImage({
        trainerId: trainerRecord.id,
        imageType: 'cover',
        file: { mimetype: fileData.mimetype, buffer },
      });

      return reply.send(branding);
    },
  );

  fastify.get(
    '/my/trainer-branding',
    {
      preHandler: [authenticate],
      schema: getStudentTrainerBrandingSchema,
    },
    async (request, reply) => {
      const result = await getStudentTrainerBranding({ studentUserId: request.user.id });
      return reply.send(result);
    },
  );
}

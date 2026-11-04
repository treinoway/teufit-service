import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-template-service.js';
import * as schema from '../schemas/training-template-route.schema.js';
import { AppError } from '../../src/errors/app-error.js';
import { AdvancedTechniqueErrorCode } from '../../src/constants/advanced-technique.js';
import { ExerciseVideoErrorCode } from '../../src/constants/exercise-video.js';

const unifiedDomainErrorCodes = new Set([...Object.values(AdvancedTechniqueErrorCode), ...Object.values(ExerciseVideoErrorCode)]);

// Tells whether an error is an advanced-technique or exercise-video domain error that must reach the unified error handler.
function isUnifiedDomainError(error) {
  return error instanceof AppError && unifiedDomainErrorCodes.has(error.error);
}

export async function trainingTemplateRoutes(fastify) {
  // Create training template
  fastify.post(
    '/trainer/training-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createTrainingTemplateSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.createTrainingTemplate(request.user.id, request.body);
        return reply.status(201).send(template);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (error.code === 'TRAINER_PROFILE_MISSING' || error.code === 'EXERCISE_TEMPLATE_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'INVALID_CATEGORY' || error.code === 'INVALID_BODY_SEGMENT') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create training template' });
      }
    },
  );

  // Get training templates (own + public) with pagination and search
  fastify.get(
    '/trainer/training-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainingTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const result = await service.getTrainingTemplatesByTrainer(request.user.id, request.query);
        return reply.send(result);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch templates' });
      }
    },
  );

  // Batch delete training templates
  fastify.post(
    '/trainer/training-templates/batch-delete',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.batchDeleteTrainingTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const result = await service.batchDeleteTrainingTemplates(request.user.id, request.body.ids);
        return reply.send(result);
      } catch (error) {
        if (error instanceof AppError) throw error;
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to batch delete training templates' });
      }
    },
  );

  // Get public templates
  fastify.get(
    '/trainer/training-templates/public',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getPublicTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const templates = await service.getPublicTrainingTemplates(request.user.id);
        return reply.send(templates);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch public templates' });
      }
    },
  );

  // Get template by ID
  fastify.get(
    '/trainer/training-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainingTemplateByIdSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.getTrainingTemplateById(request.user.id, request.params.id);
        return reply.send(template);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_PRIVATE_TEMPLATE') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch template' });
      }
    },
  );

  // Update template
  fastify.patch(
    '/trainer/training-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateTrainingTemplateSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateTrainingTemplate(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (
          error.code === 'TEMPLATE_NOT_FOUND' ||
          error.code === 'TRAINER_PROFILE_MISSING' ||
          error.code === 'EXERCISE_TEMPLATE_NOT_FOUND'
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_CATEGORY' || error.code === 'INVALID_BODY_SEGMENT') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update template' });
      }
    },
  );

  // Create an ad-hoc exercise (new ExerciseTemplate) and attach it to a training template
  fastify.post(
    '/trainer/training-templates/:templateId/exercises',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createTrainingTemplateExerciseSchema,
    },
    async (request, reply) => {
      try {
        const created = await service.createTrainingTemplateExercise(
          request.user.id,
          request.params.templateId,
          request.body,
        );
        return reply.status(201).send(created);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_EXERCISE_TYPE' || error.code === 'INVALID_REPETITIONS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create training template exercise' });
      }
    },
  );

  // Attach an existing exercise template to a training template (junction row only)
  fastify.post(
    '/trainer/training-templates/:templateId/exercises/from-template',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createTrainingTemplateExerciseFromTemplateSchema,
    },
    async (request, reply) => {
      try {
        const created = await service.createTrainingTemplateExerciseFromTemplate(
          request.user.id,
          request.params.templateId,
          request.body,
        );
        return reply.status(201).send(created);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (
          error.code === 'TEMPLATE_NOT_FOUND' ||
          error.code === 'TRAINER_PROFILE_MISSING' ||
          error.code === 'EXERCISE_TEMPLATE_NOT_FOUND'
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to attach exercise template' });
      }
    },
  );

  // Remove an exercise (junction row) from a training template. Library ExerciseTemplate is preserved.
  fastify.delete(
    '/trainer/training-templates/:templateId/exercises/:exerciseId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteTrainingTemplateExerciseSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteTrainingTemplateExercise(
          request.user.id,
          request.params.templateId,
          request.params.exerciseId,
        );
        return reply.send(deleted);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (
          error.code === 'TEMPLATE_NOT_FOUND' ||
          error.code === 'TRAINER_PROFILE_MISSING' ||
          error.code === 'TRAINING_TEMPLATE_EXERCISE_NOT_FOUND'
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete training template exercise' });
      }
    },
  );

  // Update a single exercise (junction row) inside a training template
  fastify.patch(
    '/trainer/training-templates/:templateId/exercises/:exerciseId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateTrainingTemplateExerciseSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateTrainingTemplateExercise(
          request.user.id,
          request.params.templateId,
          request.params.exerciseId,
          request.body,
        );
        return reply.send(updated);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (
          error.code === 'TEMPLATE_NOT_FOUND' ||
          error.code === 'TRAINER_PROFILE_MISSING' ||
          error.code === 'TRAINING_TEMPLATE_EXERCISE_NOT_FOUND'
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update training template exercise' });
      }
    },
  );

  fastify.post(
    '/trainer/training-templates/:templateId/supersets',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createTemplateSupersetSchema,
    },
    async (request, reply) => {
      const template = await service.createTemplateSuperset(
        request.user.id,
        request.params.templateId,
        request.body.exerciseIds,
        request.body.restInterval,
      );
      return reply.status(201).send(template);
    },
  );

  fastify.patch(
    '/trainer/training-templates/:templateId/supersets/:groupId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateTemplateSupersetRestIntervalSchema,
    },
    async (request, reply) => {
      const template = await service.updateTemplateSupersetRestInterval(
        request.user.id,
        request.params.templateId,
        request.params.groupId,
        request.body.restInterval,
      );
      return reply.send(template);
    },
  );

  fastify.delete(
    '/trainer/training-templates/:templateId/supersets/:groupId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.dissolveTemplateSupersetSchema,
    },
    async (request, reply) => {
      const template = await service.dissolveTemplateSuperset(
        request.user.id,
        request.params.templateId,
        request.params.groupId,
      );
      return reply.send(template);
    },
  );

  // Delete template
  fastify.delete(
    '/trainer/training-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteTrainingTemplateSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteTrainingTemplate(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (isUnifiedDomainError(error)) throw error;
        if (error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete template' });
      }
    },
  );
}

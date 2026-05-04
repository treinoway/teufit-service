import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-template-service.js';
import * as schema from '../schemas/training-template-route.schema.js';
import { AppError } from '../../src/errors/app-error.js';

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

  // Get training templates (own + public)
  fastify.get(
    '/trainer/training-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainingTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const templates = await service.getTrainingTemplatesByTrainer(request.user.id);
        return reply.send(templates);
      } catch (error) {
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch templates' });
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
        const templates = await service.getPublicTrainingTemplates();
        return reply.send(templates);
      } catch (error) {
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

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/exercise-template-service.js';
import * as schema from '../schemas/exercise-template-route.schema.js';
import { AppError } from '../../src/errors/app-error.js';

export async function exerciseTemplateRoutes(fastify) {
  // Create exercise template
  fastify.post(
    '/trainer/exercise-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createExerciseTemplateSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.createExerciseTemplate(request.user.id, request.body);
        return reply.status(201).send(template);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'INVALID_EXERCISE_TYPE') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create exercise template' });
      }
    },
  );

  // Get exercise templates (own + public) with pagination and search
  fastify.get(
    '/trainer/exercise-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const result = await service.getExerciseTemplatesByTrainer(request.user.id, request.query);
        return reply.send(result);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercise templates' });
      }
    },
  );

  // Batch delete exercise templates
  fastify.post(
    '/trainer/exercise-templates/batch-delete',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.batchDeleteExerciseTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const result = await service.batchDeleteExerciseTemplates(request.user.id, request.body.ids);
        return reply.send(result);
      } catch (error) {
        if (error instanceof AppError) throw error;
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to batch delete exercise templates' });
      }
    },
  );

  // Get public exercise templates
  fastify.get(
    '/trainer/exercise-templates/public',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getPublicExerciseTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const templates = await service.getPublicExerciseTemplates(request.user.id);
        return reply.send(templates);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch public exercise templates' });
      }
    },
  );

  // Get exercise template by ID
  fastify.get(
    '/trainer/exercise-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseTemplateByIdSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.getExerciseTemplateById(request.user.id, request.params.id);
        return reply.send(template);
      } catch (error) {
        if (error.code === 'EXERCISE_TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_PRIVATE_TEMPLATE') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercise template' });
      }
    },
  );

  // Update exercise template
  fastify.patch(
    '/trainer/exercise-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateExerciseTemplateSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateExerciseTemplate(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'EXERCISE_TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_EXERCISE_TYPE') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update exercise template' });
      }
    },
  );

  // Delete exercise template
  fastify.delete(
    '/trainer/exercise-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteExerciseTemplateSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteExerciseTemplate(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (error.code === 'EXERCISE_TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete exercise template' });
      }
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-template-service.js';
import * as schema from '../schemas/training-template-route.schema.js';

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
        if (error.code === 'TRAINER_PROFILE_MISSING') {
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
        if (error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
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

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-protocol-template-service.js';
import * as schema from '../schemas/training-protocol-template-route.schema.js';

export async function trainingProtocolTemplateRoutes(fastify) {
  // Create protocol template
  fastify.post(
    '/trainer/protocol-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createProtocolTemplateSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.createProtocolTemplate(request.user.id, request.body);
        return reply.status(201).send(template);
      } catch (error) {
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'INVALID_WEEK_DAYS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create protocol template' });
      }
    },
  );

  // Get all templates
  fastify.get(
    '/trainer/protocol-templates',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getProtocolTemplatesSchema,
    },
    async (request, reply) => {
      try {
        const templates = await service.getProtocolTemplatesByTrainer(request.user.id);
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

  // Get template by ID
  fastify.get(
    '/trainer/protocol-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getProtocolTemplateByIdSchema,
    },
    async (request, reply) => {
      try {
        const template = await service.getProtocolTemplateById(request.user.id, request.params.id);
        return reply.send(template);
      } catch (error) {
        if (error.code === 'TEMPLATE_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch template' });
      }
    },
  );

  // Update template
  fastify.patch(
    '/trainer/protocol-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateProtocolTemplateSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateProtocolTemplate(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (error.code === 'TEMPLATE_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_WEEK_DAYS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update template' });
      }
    },
  );

  // Delete template
  fastify.delete(
    '/trainer/protocol-templates/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteProtocolTemplateSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteProtocolTemplate(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (error.code === 'TEMPLATE_NOT_FOUND') {
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

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-protocol-service.js';
import * as schema from '../schemas/training-protocol-route.schema.js';

export async function trainingProtocolRoutes(fastify) {
  // ========== TRAINER ROUTES ==========

  // Create protocol
  fastify.post(
    '/trainer/protocols',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createProtocolSchema,
    },
    async (request, reply) => {
      try {
        const protocol = await service.createProtocol(request.user.id, request.body);
        return reply.status(201).send(protocol);
      } catch (error) {
        if (error.code === 'TRAINER_PROFILE_MISSING' || error.code === 'ASSIGNEE_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'INVALID_WEEK_DAYS' || error.code === 'INVALID_STATUS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create protocol' });
      }
    },
  );

  // Get protocols created by trainer
  fastify.get(
    '/trainer/protocols',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainerProtocolsSchema,
    },
    async (request, reply) => {
      try {
        const protocols = await service.getProtocolsByTrainer(request.user.id, request.query);
        return reply.send(protocols);
      } catch (error) {
        if (error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'INVALID_STATUS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch protocols' });
      }
    },
  );

  // Get protocol by ID (trainer context)
  fastify.get(
    '/trainer/protocols/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getProtocolByIdSchema,
    },
    async (request, reply) => {
      try {
        const protocol = await service.getProtocolById(request.user.id, request.params.id, 'trainer');
        return reply.send(protocol);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch protocol' });
      }
    },
  );

  // Update protocol
  fastify.patch(
    '/trainer/protocols/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateProtocolSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateProtocol(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_WEEK_DAYS' || error.code === 'INVALID_STATUS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update protocol' });
      }
    },
  );

  // Delete protocol
  fastify.delete(
    '/trainer/protocols/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteProtocolSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteProtocol(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete protocol' });
      }
    },
  );

  // Import from template
  fastify.post(
    '/trainer/protocols/from-template',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.importFromTemplateSchema,
    },
    async (request, reply) => {
      try {
        const { templateId, assigneeId, ...data } = request.body;
        const protocol = await service.importFromTemplate(request.user.id, templateId, assigneeId, data);
        return reply.status(201).send(protocol);
      } catch (error) {
        if (error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'ASSIGNEE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_TEMPLATE_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to import protocol from template' });
      }
    },
  );

  // ========== MY PROTOCOLS ROUTES ==========

  // Get protocols assigned to user (authenticated, no role required)
  fastify.get(
    '/my/protocols',
    {
      preHandler: [authenticate],
      schema: schema.getMyProtocolsSchema,
    },
    async (request, reply) => {
      try {
        const protocols = await service.getMyProtocols(request.user.id, request.query);
        return reply.send(protocols);
      } catch (error) {
        if (error.code === 'INVALID_STATUS') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch protocols' });
      }
    },
  );

  // Get protocol by ID (assignee context)
  fastify.get(
    '/my/protocols/:id',
    {
      preHandler: [authenticate],
      schema: schema.getMyProtocolByIdSchema,
    },
    async (request, reply) => {
      try {
        const protocol = await service.getProtocolById(request.user.id, request.params.id, 'assignee');
        return reply.send(protocol);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_YOUR_PROTOCOL') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch protocol' });
      }
    },
  );
}

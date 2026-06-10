import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-protocol-service.js';
import * as schema from '../schemas/training-protocol-route.schema.js';
import config from '../../config/index.js';

export async function trainingProtocolRoutes(fastify) {
  // ========== TRAINER ROUTES ==========

  // Rate limit: 20 req/min
  // Create protocol
  fastify.post(
    '/trainer/protocols',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.create },
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

  // Rate limit: 10 req/min
  // Create protocol with all trainings and exercises in one atomic request
  fastify.post(
    '/trainer/protocols/with-trainings',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.createWithTrainings },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createProtocolWithTrainingsSchema,
    },
    async (request, reply) => {
      const protocol = await service.createProtocolWithTrainings(request.user.id, request.body);
      return reply.status(201).send(protocol);
    },
  );

  // Rate limit: 60 req/min
  // Get protocols created by trainer
  fastify.get(
    '/trainer/protocols',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.list },
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

  // Rate limit: 60 req/min
  // Get protocol by ID (trainer context)
  fastify.get(
    '/trainer/protocols/:id',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.getById },
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

  // Rate limit: 20 req/min
  // Update protocol
  fastify.patch(
    '/trainer/protocols/:id',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.update },
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

  // Rate limit: 10 req/min
  // Delete protocol
  fastify.delete(
    '/trainer/protocols/:id',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.delete },
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
        if (error.code === 'PROTOCOL_STATUS_NOT_DELETABLE') {
          return reply.status(409).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete protocol' });
      }
    },
  );

  // Rate limit: 10 req/min
  // Import from template
  fastify.post(
    '/trainer/protocols/import-from-template',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.importFromTemplate },
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

  // Rate limit: 60 req/min
  // Get protocols assigned to user (authenticated, no role required)
  fastify.get(
    '/my/protocols',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.list },
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

  // Rate limit: 60 req/min
  // Get protocol by ID (assignee context)
  fastify.get(
    '/my/protocols/:id',
    {
      config: { rateLimit: config.rateLimit.trainingProtocol.getById },
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

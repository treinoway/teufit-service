import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/training-service.js';
import * as schema from '../schemas/training-route.schema.js';

export async function trainingRoutes(fastify) {
  // ========== TRAINER ROUTES ==========

  // Create training
  fastify.post(
    '/trainer/protocols/:protocolId/trainings',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createTrainingSchema,
    },
    async (request, reply) => {
      try {
        const training = await service.createTraining(request.user.id, request.params.protocolId, request.body);
        return reply.status(201).send(training);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_CATEGORY' || error.code === 'INVALID_BODY_SEGMENT' || error.code === 'INVALID_WEEK_DAY') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create training' });
      }
    },
  );

  // Get trainings (trainer context)
  fastify.get(
    '/trainer/protocols/:protocolId/trainings',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainingsSchema,
    },
    async (request, reply) => {
      try {
        const trainings = await service.getTrainingsByProtocol(request.user.id, request.params.protocolId, 'trainer');
        return reply.send(trainings);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch trainings' });
      }
    },
  );

  // Get training by ID (trainer context)
  fastify.get(
    '/trainer/trainings/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getTrainingByIdSchema,
    },
    async (request, reply) => {
      try {
        const training = await service.getTrainingById(request.user.id, request.params.id, 'trainer');
        return reply.send(training);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch training' });
      }
    },
  );

  // Update training
  fastify.patch(
    '/trainer/trainings/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateTrainingSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateTraining(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_CATEGORY' || error.code === 'INVALID_BODY_SEGMENT' || error.code === 'INVALID_WEEK_DAY') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update training' });
      }
    },
  );

  // Delete training
  fastify.delete(
    '/trainer/trainings/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteTrainingSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteTraining(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete training' });
      }
    },
  );

  // Import from template
  fastify.post(
    '/trainer/trainings/from-template',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.importTrainingFromTemplateSchema,
    },
    async (request, reply) => {
      try {
        const { protocolId, templateId, ...data } = request.body;
        const training = await service.importFromTemplate(request.user.id, protocolId, templateId, data);
        return reply.status(201).send(training);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND' || error.code === 'TEMPLATE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER' || error.code === 'FORBIDDEN_PRIVATE_TEMPLATE') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to import training from template' });
      }
    },
  );

  // ========== MY PROTOCOLS ROUTES ==========

  // Get trainings (assignee context)
  fastify.get(
    '/my/protocols/:protocolId/trainings',
    {
      preHandler: [authenticate],
      schema: schema.getTrainingsSchema,
    },
    async (request, reply) => {
      try {
        const trainings = await service.getTrainingsByProtocol(request.user.id, request.params.protocolId, 'assignee');
        return reply.send(trainings);
      } catch (error) {
        if (error.code === 'PROTOCOL_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_YOUR_PROTOCOL') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch trainings' });
      }
    },
  );

  // Get training by ID (assignee context)
  fastify.get(
    '/my/trainings/:id',
    {
      preHandler: [authenticate],
      schema: schema.getTrainingByIdSchema,
    },
    async (request, reply) => {
      try {
        const training = await service.getTrainingById(request.user.id, request.params.id, 'assignee');
        return reply.send(training);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_YOUR_TRAINING') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch training' });
      }
    },
  );
}

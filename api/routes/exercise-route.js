import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/exercise-service.js';
import * as schema from '../schemas/exercise-route.schema.js';
import { AppError } from '../../src/errors/app-error.js';

export async function exerciseRoutes(fastify) {
  // ========== TRAINER ROUTES ==========

  // Create exercise
  fastify.post(
    '/trainer/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createExerciseSchema,
    },
    async (request, reply) => {
      try {
        const exercise = await service.createExercise(
          request.user.id,
          request.params.trainingId,
          request.body,
        );
        return reply.status(201).send(exercise);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'TRAINING_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_EXERCISE_TYPE') {
          return reply.status(400).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create exercise' });
      }
    },
  );

  // Create exercise from template
  fastify.post(
    '/trainer/exercises/from-template',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createExerciseFromTemplateSchema,
    },
    async (request, reply) => {
      try {
        const { trainingId, templateId, ...data } = request.body;
        const exercise = await service.createFromTemplate(
          request.user.id,
          trainingId,
          templateId,
          data,
        );
        return reply.status(201).send(exercise);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (
          error.code === 'TRAINING_NOT_FOUND' ||
          error.code === 'EXERCISE_TEMPLATE_NOT_FOUND' ||
          error.code === 'TRAINER_PROFILE_MISSING'
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER' || error.code === 'FORBIDDEN_PRIVATE_TEMPLATE') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create exercise from template' });
      }
    },
  );

  // Get exercises by training (trainer context)
  fastify.get(
    '/trainer/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExercisesSchema,
    },
    async (request, reply) => {
      try {
        const exercises = await service.getExercisesByTraining(
          request.user.id,
          request.params.trainingId,
          'trainer',
        );
        return reply.send(exercises);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercises' });
      }
    },
  );

  // Get exercise by ID (trainer context)
  fastify.get(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseByIdSchema,
    },
    async (request, reply) => {
      try {
        const exercise = await service.getExerciseById(request.user.id, request.params.id, 'trainer');
        return reply.send(exercise);
      } catch (error) {
        if (error.code === 'EXERCISE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercise' });
      }
    },
  );

  // Update exercise
  fastify.patch(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateExerciseSchema,
    },
    async (request, reply) => {
      try {
        const updated = await service.updateExercise(request.user.id, request.params.id, request.body);
        return reply.send(updated);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code === 'EXERCISE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        if (error.code === 'INVALID_EXERCISE_TYPE' || error.code === 'VALIDATION_ERROR') {
          return reply.status(400).send({
            error: error.error ?? error.code,
            messageCode: error.messageCode ?? 'validation.failed',
            message: error.message,
          });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update exercise' });
      }
    },
  );

  // Delete exercise
  fastify.delete(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteExerciseSchema,
    },
    async (request, reply) => {
      try {
        const deleted = await service.deleteExercise(request.user.id, request.params.id);
        return reply.send(deleted);
      } catch (error) {
        if (error.code === 'EXERCISE_NOT_FOUND' || error.code === 'TRAINER_PROFILE_MISSING') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_PROTOCOL_OWNER') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete exercise' });
      }
    },
  );

  // ========== MY ROUTES (ASSIGNEE) ==========

  // Get exercises by training (assignee context)
  fastify.get(
    '/my/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate],
      schema: schema.getExercisesSchema,
    },
    async (request, reply) => {
      try {
        const exercises = await service.getExercisesByTraining(
          request.user.id,
          request.params.trainingId,
          'assignee',
        );
        return reply.send(exercises);
      } catch (error) {
        if (error.code === 'TRAINING_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_YOUR_TRAINING') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercises' });
      }
    },
  );

  // Get exercise by ID (assignee context)
  fastify.get(
    '/my/exercises/:id',
    {
      preHandler: [authenticate],
      schema: schema.getExerciseByIdSchema,
    },
    async (request, reply) => {
      try {
        const exercise = await service.getExerciseById(request.user.id, request.params.id, 'assignee');
        return reply.send(exercise);
      } catch (error) {
        if (error.code === 'EXERCISE_NOT_FOUND') {
          return reply.status(404).send({ error: error.message });
        }
        if (error.code === 'FORBIDDEN_NOT_YOUR_EXERCISE') {
          return reply.status(403).send({ error: error.message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch exercise' });
      }
    },
  );
}

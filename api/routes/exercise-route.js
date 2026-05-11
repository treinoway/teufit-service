import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/exercise-service.js';
import * as schema from '../schemas/exercise-route.schema.js';

export async function exerciseRoutes(fastify) {
  // ========== TRAINER ROUTES ==========

  // POST /trainer/trainings/:trainingId/exercises — Create exercise
  fastify.post(
    '/trainer/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createExerciseSchema,
    },
    async (request, reply) => {
      const exercise = await service.createExercise(
        request.user.id,
        request.params.trainingId,
        request.body,
      );
      return reply.status(201).send(exercise);
    },
  );

  // POST /trainer/exercises/from-template — Create exercise from template
  fastify.post(
    '/trainer/exercises/from-template',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.createExerciseFromTemplateSchema,
    },
    async (request, reply) => {
      const { trainingId, templateId, ...data } = request.body;
      const exercise = await service.createFromTemplate(
        request.user.id,
        trainingId,
        templateId,
        data,
      );
      return reply.status(201).send(exercise);
    },
  );

  // GET /trainer/trainings/:trainingId/exercises — Get exercises by training (trainer context)
  fastify.get(
    '/trainer/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExercisesSchema,
    },
    async (request, reply) => {
      const exercises = await service.getExercisesByTraining(
        request.user.id,
        request.params.trainingId,
        'trainer',
      );
      return reply.send(exercises);
    },
  );

  // GET /trainer/exercises/:id — Get exercise by ID (trainer context)
  fastify.get(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseByIdSchema,
    },
    async (request, reply) => {
      const exercise = await service.getExerciseById(request.user.id, request.params.id, 'trainer');
      return reply.send(exercise);
    },
  );

  // PATCH /trainer/exercises/:id — Update exercise
  fastify.patch(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.updateExerciseSchema,
    },
    async (request, reply) => {
      const updated = await service.updateExercise(request.user.id, request.params.id, request.body);
      return reply.send(updated);
    },
  );

  // DELETE /trainer/exercises/:id — Delete exercise (cascades to substitutes)
  fastify.delete(
    '/trainer/exercises/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.deleteExerciseSchema,
    },
    async (request, reply) => {
      const deleted = await service.deleteExercise(request.user.id, request.params.id);
      return reply.send(deleted);
    },
  );

  // POST /trainer/exercises/:id/substitutes — Add substitute under a principal
  fastify.post(
    '/trainer/exercises/:id/substitutes',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.addSubstituteSchema,
    },
    async (request, reply) => {
      const substitute = await service.addSubstitute(
        request.user.id,
        request.params.id,
        request.body,
      );
      return reply.status(201).send(substitute);
    },
  );

  // PATCH /trainer/exercises/:id/substitutes/order — Reorder substitutes
  fastify.patch(
    '/trainer/exercises/:id/substitutes/order',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.reorderSubstitutesSchema,
    },
    async (request, reply) => {
      const result = await service.reorderSubstitutes(
        request.user.id,
        request.params.id,
        request.body.substituteIds,
      );
      return reply.send(result);
    },
  );

  // PATCH /trainer/trainings/:trainingId/supersets/:groupId/order — Reorder superset members
  fastify.patch(
    '/trainer/trainings/:trainingId/supersets/:groupId/order',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.reorderSupersetMembersSchema,
    },
    async (request, reply) => {
      const result = await service.reorderSupersetMembers(
        request.user.id,
        request.params.trainingId,
        request.params.groupId,
        request.body.exerciseIds,
      );
      return reply.send(result);
    },
  );

  // ========== MY ROUTES (ASSIGNEE) ==========

  // GET /my/trainings/:trainingId/exercises — Get exercises by training (assignee context)
  fastify.get(
    '/my/trainings/:trainingId/exercises',
    {
      preHandler: [authenticate],
      schema: schema.getExercisesSchema,
    },
    async (request, reply) => {
      const exercises = await service.getExercisesByTraining(
        request.user.id,
        request.params.trainingId,
        'assignee',
      );
      return reply.send(exercises);
    },
  );

  // GET /my/exercises/:id — Get exercise by ID (assignee context)
  fastify.get(
    '/my/exercises/:id',
    {
      preHandler: [authenticate],
      schema: schema.getExerciseByIdSchema,
    },
    async (request, reply) => {
      const exercise = await service.getExerciseById(request.user.id, request.params.id, 'assignee');
      return reply.send(exercise);
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import * as service from '../../src/services/workout-session-service.js';
import * as schema from '../schemas/workout-session-route.schema.js';

export async function workoutSessionRoutes(fastify) {
  // ═══════════════════════════════════════════════════════════
  // STUDENT ROUTES — /my/
  // ═══════════════════════════════════════════════════════════

  // POST /my/trainings/:trainingId/workout-sessions — Start session
  fastify.post(
    '/my/trainings/:trainingId/workout-sessions',
    {
      preHandler: [authenticate],
      schema: schema.startSessionSchema,
    },
    async (request, reply) => {
      const session = await service.startSession(
        request.user.id,
        request.params.trainingId,
        request.body,
      );
      return reply.status(201).send(session);
    },
  );

  // GET /my/workout-sessions — List sessions
  fastify.get(
    '/my/workout-sessions',
    {
      preHandler: [authenticate],
      schema: schema.listSessionsSchema,
    },
    async (request, reply) => {
      const result = await service.listSessions(request.user.id, request.query);
      return reply.send(result);
    },
  );

  // GET /my/workout-sessions/:sessionId — Get session detail
  fastify.get(
    '/my/workout-sessions/:sessionId',
    {
      preHandler: [authenticate],
      schema: schema.getSessionSchema,
    },
    async (request, reply) => {
      const session = await service.getSession(request.user.id, request.params.sessionId);
      return reply.send(session);
    },
  );

  // PATCH /my/workout-sessions/:sessionId — Update session
  fastify.patch(
    '/my/workout-sessions/:sessionId',
    {
      preHandler: [authenticate],
      schema: schema.updateSessionSchema,
    },
    async (request, reply) => {
      const updated = await service.updateSession(
        request.user.id,
        request.params.sessionId,
        request.body,
      );
      return reply.send(updated);
    },
  );

  // DELETE /my/workout-sessions/:sessionId — Soft-delete session
  fastify.delete(
    '/my/workout-sessions/:sessionId',
    {
      preHandler: [authenticate],
      schema: schema.deleteSessionSchema,
    },
    async (request, reply) => {
      const deleted = await service.deleteSession(request.user.id, request.params.sessionId);
      return reply.send(deleted);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // EXERCISE LOG ROUTES — nested under session
  // ═══════════════════════════════════════════════════════════

  // PATCH /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId
  fastify.patch(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId',
    {
      preHandler: [authenticate],
      schema: schema.updateExerciseLogSchema,
    },
    async (request, reply) => {
      const updated = await service.updateExerciseLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
        request.body,
      );
      return reply.send(updated);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // SET LOG ROUTES — nested under exercise log
  // ═══════════════════════════════════════════════════════════

  // POST /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets
  fastify.post(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets',
    {
      preHandler: [authenticate],
      schema: schema.createSetLogSchema,
    },
    async (request, reply) => {
      const setLog = await service.createSetLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
        request.body,
      );
      return reply.status(201).send(setLog);
    },
  );

  // PATCH /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId
  fastify.patch(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId',
    {
      preHandler: [authenticate],
      schema: schema.updateSetLogSchema,
    },
    async (request, reply) => {
      const updated = await service.updateSetLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
        request.params.setLogId,
        request.body,
      );
      return reply.send(updated);
    },
  );

  // DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId
  fastify.delete(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId',
    {
      preHandler: [authenticate],
      schema: schema.deleteSetLogSchema,
    },
    async (request, reply) => {
      const deleted = await service.deleteSetLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
        request.params.setLogId,
      );
      return reply.send(deleted);
    },
  );

  // GET /my/exercises/:exerciseId/last-performance — Last logged performance for an exercise
  fastify.get(
    '/my/exercises/:exerciseId/last-performance',
    {
      preHandler: [authenticate],
      schema: schema.getExerciseLastPerformanceSchema,
    },
    async (request, reply) => {
      const result = await service.getExerciseLastPerformance(
        request.user.id,
        request.params.exerciseId,
      );
      return reply.send(result);
    },
  );

  // DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId — Undo substitute swap
  fastify.delete(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId',
    {
      preHandler: [authenticate],
      schema: schema.undoSubstituteExerciseLogSchema,
    },
    async (request, reply) => {
      await service.undoSubstituteExerciseLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
      );
      return reply.status(204).send();
    },
  );

  // POST /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/substitute
  fastify.post(
    '/my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/substitute',
    {
      preHandler: [authenticate],
      schema: schema.substituteExerciseLogSchema,
    },
    async (request, reply) => {
      const newLog = await service.substituteExerciseLog(
        request.user.id,
        request.params.sessionId,
        request.params.exerciseLogId,
        request.body.substituteExerciseId,
      );
      return reply.status(201).send(newLog);
    },
  );

  // ═══════════════════════════════════════════════════════════
  // TRAINER ROUTES — /trainer/students/:studentId/
  // ═══════════════════════════════════════════════════════════

  // GET /trainer/students/:studentId/workout-sessions — List student sessions
  fastify.get(
    '/trainer/students/:studentId/workout-sessions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.listStudentSessionsSchema,
    },
    async (request, reply) => {
      const result = await service.listStudentSessions(
        request.user.id,
        request.params.studentId,
        request.query,
      );
      return reply.send(result);
    },
  );

  // GET /trainer/students/:studentId/workout-sessions/:sessionId — Get student session detail
  fastify.get(
    '/trainer/students/:studentId/workout-sessions/:sessionId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getStudentSessionSchema,
    },
    async (request, reply) => {
      const session = await service.getStudentSession(
        request.user.id,
        request.params.studentId,
        request.params.sessionId,
      );
      return reply.send(session);
    },
  );
}

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { resolveTimeZone } from '../../src/helpers/timezone.js';
import * as service from '../../src/services/student-dashboard-service.js';
import * as schema from '../schemas/student-dashboard-route.schema.js';

export async function studentDashboardRoutes(fastify) {
  // GET /trainer/students/:studentId/dashboard/summary
  fastify.get(
    '/trainer/students/:studentId/dashboard/summary',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getDashboardSummarySchema,
    },
    async (request, reply) => {
      const timeZone = resolveTimeZone(request.headers['app-timezone']);
      const summary = await service.getDashboardSummary(
        request.user.id,
        request.params.studentId,
        { ...request.query, timeZone },
      );
      return reply.send(summary);
    },
  );

  // GET /trainer/students/:studentId/dashboard/recent-sessions
  fastify.get(
    '/trainer/students/:studentId/dashboard/recent-sessions',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getRecentSessionsSchema,
    },
    async (request, reply) => {
      const result = await service.getRecentSessions(
        request.user.id,
        request.params.studentId,
        request.query,
      );
      return reply.send(result);
    },
  );

  // GET /trainer/students/:studentId/dashboard/exercise-progression
  fastify.get(
    '/trainer/students/:studentId/dashboard/exercise-progression',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseProgressionSchema,
    },
    async (request, reply) => {
      const result = await service.getExerciseProgression(
        request.user.id,
        request.params.studentId,
        request.query,
      );
      return reply.send(result);
    },
  );

  // GET /trainer/students/:studentId/dashboard/exercise-progression/:exerciseId
  fastify.get(
    '/trainer/students/:studentId/dashboard/exercise-progression/:exerciseId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getExerciseProgressionDetailSchema,
    },
    async (request, reply) => {
      const result = await service.getExerciseProgressionDetail(
        request.user.id,
        request.params.studentId,
        request.params.exerciseId,
        request.query,
      );
      return reply.send(result);
    },
  );

  // GET /trainer/students/:studentId/dashboard/daily-activity
  fastify.get(
    '/trainer/students/:studentId/dashboard/daily-activity',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: schema.getDailyActivitySchema,
    },
    async (request, reply) => {
      const timeZone = resolveTimeZone(request.headers['app-timezone']);
      const result = await service.getDailyActivity(
        request.user.id,
        request.params.studentId,
        { ...request.query, timeZone },
      );
      return reply.send(result);
    },
  );
}

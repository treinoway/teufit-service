import { authenticate } from '../middleware/auth.js';
import { getTodayWorkout } from '../../src/services/workouts-today-service.js';
import { resolveTimeZone } from '../../src/helpers/timezone.js';
import { getWorkoutsTodaySchema } from '../schemas/workouts-today-route.schema.js';

export async function workoutsTodayRoutes(fastify) {
  // GET /my/workouts/today — Returns the training the student should do today
  fastify.get(
    '/my/workouts/today',
    {
      preHandler: [authenticate],
      schema: getWorkoutsTodaySchema,
    },
    async (request, reply) => {
      const timeZone = resolveTimeZone(request.headers['app-timezone']);
      const result = await getTodayWorkout(request.user.id, { timeZone });
      return reply.send(result);
    },
  );
}

import { authenticate } from '../middleware/auth.js';
import { getUserProfileById } from '../../src/services/user-service.js';
import { getMeSchema } from '../schemas/user-route.schema.js';

export async function userRoutes(fastify) {

  fastify.get(
    '/me',
    {
      preHandler: [authenticate],
      schema: getMeSchema,
    },
    async (request, reply) => {
      try {
        const userId = request.user.id;
        const userProfile = await getUserProfileById(userId);
        return reply.send(userProfile);
      } catch (error) {
        request.log.error({ error }, 'Error fetching user profile in GET /me');

        if (error?.code === 'USER_ID_REQUIRED') {
          return reply.status(400).send({ error: 'USER_ID_REQUIRED' });
        }
        if (error?.code === 'USER_NOT_FOUND') {
          return reply.status(404).send({ error: 'User not found' });
        }

        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
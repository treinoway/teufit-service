import { authenticate } from '../middleware/auth.js';
import { getUserProfileById } from '../../src/services/userService.js';

export async function userRoutes(fastify) {

  fastify.get(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['user'],
        summary: 'Get current user profile',
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          required: ['authorization'],
          properties: {
            authorization: {
              type: 'string',
              description: 'Bearer access token (e.g., "Bearer <token>")',
            },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          401: { type: 'object', properties: { error: { type: 'string' } } },
          500: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
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
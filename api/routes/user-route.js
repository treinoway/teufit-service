import { authenticate } from '../middleware/auth.js';
import { getUserProfileById, setActiveProfileToTrainer, updateUserProfile } from '../../src/services/user-service.js';
import { getMeSchema, becomeTrainerSchema, updateProfileSchema } from '../schemas/user-route.schema.js';
import { parseIncludeParameter } from '../../src/helpers/query-parser.js';
import { ALLOWED_USER_RELATIONS } from '../../src/constants/user-relations.js';

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

        // Parse and validate ?include parameter
        const { relations, invalid } = parseIncludeParameter(
          request.query.include,
          ALLOWED_USER_RELATIONS
        );

        // Return 400 if invalid relations were requested
        if (invalid.length > 0) {
          return reply.status(400).send({
            error: 'INVALID_RELATIONS',
            message: `Invalid relations requested: ${invalid.join(', ')}`,
            allowedRelations: Array.from(ALLOWED_USER_RELATIONS),
          });
        }

        const userProfile = await getUserProfileById(userId, relations);
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

  fastify.patch(
    '/become-trainer',
    {
      preHandler: [authenticate],
      schema: becomeTrainerSchema,
    },
    async (request, reply) => {
      try {
        const userId = request.user.id;
        const preferences = await setActiveProfileToTrainer(userId);

        return reply.send({ activeProfile: preferences.activeProfile });
      } catch (error) {
        request.log.error({ error }, 'Error updating activeProfile in PATCH /become-trainer');

        if (error?.code === 'USER_ID_REQUIRED') {
          return reply.status(400).send({ error: 'USER_ID_REQUIRED' });
        }

        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  fastify.patch('/me/profile', 
    {
      preHandler: [authenticate],
      schema: updateProfileSchema
    }, 
    async (request, reply) => {
      try {
        const userId = request.user.id;
        const updateData = request.body;

        // Validate at least one field is provided
        if (Object.keys(updateData).length === 0) {
          return reply.status(400).send({ error: 'At least one field must be provided' });
        }

        const updatedProfile = await updateUserProfile(userId, updateData);
        return reply.send(updatedProfile);
      } catch (error) {
        request.log.error({ error }, 'Error updating user profile in PATCH /me/profile');

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
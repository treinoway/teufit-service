import { authenticate } from '../middleware/auth.js';
import { getUserProfileById, setActiveProfileToTrainer, updateUserProfile } from '../../src/services/user-service.js';
import { parseIncludeParameter } from '../../src/helpers/query-parser.js';
import { ALLOWED_USER_RELATIONS } from '../../src/constants/user-relations.js';
import { uploadAvatar } from '../../src/services/avatar-service.js';
import { getMeSchema, becomeTrainerSchema, updateProfileSchema, uploadAvatarSchema } from '../schemas/user-route.schema.js';

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

  fastify.post(
    '/me/avatar',
    {
      preHandler: [authenticate],
      schema: uploadAvatarSchema,
    },
    async (request, reply) => {
      try {
        const userId = request.user.id;

        // Get file from multipart upload
        let data;
        try {
          data = await request.file();
        } catch (err) {
          // request.file() throws if content-type is not multipart/form-data
          // or if file size exceeds limit
          if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.message?.includes('too large')) {
            return reply.status(400).send({
              error: 'FILE_TOO_LARGE',
              message: err.message || 'File size exceeds 5MB limit'
            });
          }
          return reply.status(400).send({
            error: 'FILE_REQUIRED',
            message: err.message || 'Avatar file is required'
          });
        }

        if (!data) {
          return reply.status(400).send({
            error: 'FILE_REQUIRED',
            message: 'Avatar file is required'
          });
        }

        // Convert stream to buffer
        let buffer;
        try {
          buffer = await data.toBuffer();
        } catch (err) {
          // toBuffer() can throw if file is too large
          if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.message?.includes('too large')) {
            return reply.status(400).send({
              error: 'FILE_TOO_LARGE',
              message: err.message || 'File size exceeds 5MB limit'
            });
          }
          throw err;
        }

        // Pass to service
        const updatedProfile = await uploadAvatar(userId, {
          filename: data.filename,
          mimetype: data.mimetype,
          buffer,
        });

        return reply.send(updatedProfile);
      } catch (error) {
        request.log.error({ error }, 'Error uploading avatar in POST /me/avatar');

        if (error?.code === 'FILE_REQUIRED') {
          return reply.status(400).send({ error: 'FILE_REQUIRED', message: error.message });
        }
        if (error?.code === 'INVALID_FILE_TYPE') {
          return reply.status(400).send({ error: 'INVALID_FILE_TYPE', message: error.message });
        }
        if (error?.code === 'FILE_TOO_LARGE') {
          return reply.status(400).send({ error: 'FILE_TOO_LARGE', message: error.message });
        }
        if (error?.code === 'USER_NOT_FOUND') {
          return reply.status(404).send({ error: 'USER_NOT_FOUND', message: error.message });
        }
        if (error?.code === 'S3_UPLOAD_FAILED') {
          return reply.status(502).send({ error: 'S3_UPLOAD_FAILED', message: error.message });
        }

        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
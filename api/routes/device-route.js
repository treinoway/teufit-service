import { prisma } from '../../src/db.js';
import { authenticate } from '../middleware/auth.js';
import { registerDevice, removeDevice } from '../../src/services/device-service.js';
import { registerDeviceSchema, removeDeviceSchema } from '../schemas/device-route.schema.js';

/**
 * Authenticated push-token routes: POST /me/devices (upsert) and DELETE /me/devices/:token (logout).
 */
export async function deviceRoutes(fastify) {
  fastify.post(
    '/me/devices',
    { preHandler: [authenticate], schema: registerDeviceSchema },
    async (request) => registerDevice(request.user.id, request.body, prisma),
  );

  fastify.delete(
    '/me/devices/:token',
    { preHandler: [authenticate], schema: removeDeviceSchema },
    async (request, reply) => {
      await removeDevice(request.user.id, request.params.token, prisma);
      return reply.status(204).send();
    },
  );
}

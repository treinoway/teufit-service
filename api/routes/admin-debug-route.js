import { authenticate, requireAdmin } from '../middleware/auth.js';
import * as schema from '../schemas/admin-debug-route.schema.js';

// TEMPORARY: remove this file (and its registration in api/server.js) once Rollbar reporting
// is verified in production.

export const ROLLBAR_TEST_ERROR_MESSAGE = 'Rollbar test error triggered from /admin/debug/rollbar-test';

// Registers an admin-only route that always throws, so a real 5xx reaches Rollbar/Sentry.
export async function adminDebugRoutes(fastify) {
  fastify.post(
    '/admin/debug/rollbar-test',
    {
      preHandler: [authenticate, requireAdmin()],
      schema: schema.rollbarTestSchema,
    },
    async () => {
      throw new Error(ROLLBAR_TEST_ERROR_MESSAGE);
    },
  );
}

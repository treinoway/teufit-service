import { MobileAppEnv } from '../../src/constants/mobile-app.js';
import { parseAppMinVersions, resolveAppMinVersion } from '../../src/services/app-version-service.js';
import { getAppMinVersionSchema } from '../schemas/app-route.schema.js';

/**
 * Public GET /app/min-version, so an outdated app can be told to update before login.
 */
export async function appRoutes(fastify) {
  const minVersions = parseAppMinVersions(process.env[MobileAppEnv.MIN_VERSIONS], fastify.log);

  fastify.get(
    '/app/min-version',
    { schema: getAppMinVersionSchema },
    async (request) => resolveAppMinVersion(minVersions, request.query),
  );
}

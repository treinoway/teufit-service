import { buildServer } from '../../api/server.js';

/**
 * Setup test environment variables and build server instance for E2E tests.
 * Centralizes common configuration needed across all E2E test files.
 * 
 * @param {Object} options - Optional Fastify server options
 * @param {boolean} options.logger - Enable/disable logging (default: false)
 * @returns {Promise<FastifyInstance>} Configured server instance
 */
export async function setupApp(options = { logger: false }) {
  // Ensure secrets are set for JWT and session plugins in tests
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || 'test-session-secret-key-for-e2e-tests-012345';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

  // Provide dummy Google OAuth configuration so fastify-oauth2 can register
  process.env.GOOGLE_OAUTH_CLIENT_ID =
    process.env.GOOGLE_OAUTH_CLIENT_ID || 'test-google-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'test-google-client-secret';
  process.env.GOOGLE_OAUTH_CALLBACK_URL =
    process.env.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

  // Disable S3 uploads in tests (already set in vitest.config.js but ensure it's set)
  process.env.DISABLE_S3_UPLOAD = process.env.DISABLE_S3_UPLOAD || 'true';

  return await buildServer(options);
}

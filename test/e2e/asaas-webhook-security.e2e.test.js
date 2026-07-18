import 'dotenv/config';
import { afterEach, describe, it, expect, vi } from 'vitest';

/**
 * Module-isolation tests for the Asaas webhook security fix.
 *
 * These tests exercise two things that the main `asaas-webhook.e2e.test.js` suite
 * cannot cover, because `config/index.js` snapshots `process.env` once at import
 * time (see vitest.config.js `test.env` comment) and that suite relies on
 * ASAAS_WEBHOOK_SECRET being set consistently across the whole run:
 *
 *   1. buildServer() refuses to boot in production/staging when
 *      ASAAS_WEBHOOK_SECRET is missing (api/server.js boot guard).
 *   2. The route itself fails closed (401) at runtime if it ever ends up
 *      running with no webhook secret configured — defense in depth in case
 *      the boot guard is ever bypassed or misconfigured.
 *
 * To get a fresh `config/index.js` (and therefore a fresh `config.asaas.webhookSecret`)
 * per test, we combine `vi.resetModules()` with `vi.stubEnv()` and a dynamic
 * `import()` *inside* each test — importing at the top of the file would just reuse
 * the module graph already cached from vitest.config.js's `test.env` values.
 *
 * Kept in a dedicated file (not inside asaas-webhook.e2e.test.js) so that
 * vi.resetModules() here can never leak a stale api/server.js / config/index.js
 * module instance into the 11 "happy path" tests in that file, which depend on
 * config.asaas.webhookSecret === 'test-webhook-secret-123' from vitest.config.js.
 */

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// Minimal env required for buildServer() to complete a *full* boot (session/JWT
// secrets + Google OAuth config consumed by authRoutes — see test/helpers/setup-app.js
// for the equivalent list used by the rest of the E2E suite).
function stubMinimalBootEnv() {
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-key-for-e2e-tests-012345');
  vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-google-client-id');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-google-client-secret');
  vi.stubEnv('GOOGLE_OAUTH_CALLBACK_URL', 'http://localhost:3000/auth/google/callback');
  vi.stubEnv('DISABLE_S3_UPLOAD', 'true');
}

e2eDescribe('e2e: asaas webhook security (module-isolated)', () => {
  afterEach(() => {
    // Restore process.env to what it was before this test's vi.stubEnv() calls,
    // then drop the module cache so the NEXT test (or the next test FILE, since
    // fileParallelism is false and files may share a worker) re-imports
    // config/index.js and api/server.js against real env again.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('buildServer() boot guard', () => {
    it('rejects boot in production when ASAAS_API_KEY is set but ASAAS_WEBHOOK_SECRET is missing', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      // apiKey present is the pre-requisite for the guard to fire at all — see
      // src/helpers/asaas-webhook-helpers.js. Stubbed explicitly (rather than
      // relying on whatever ASAAS_API_KEY this process's .env happened to load)
      // so this test doesn't depend on which e2e file ran first in this worker.
      vi.stubEnv('ASAAS_API_KEY', 'test-asaas-api-key');
      vi.stubEnv('ASAAS_WEBHOOK_SECRET', '');

      const { buildServer } = await import('../../api/server.js');

      // The guard is the very first statement in buildServer() — it throws before
      // Fastify() is even instantiated, so there is no app instance to close here.
      await expect(buildServer()).rejects.toThrow(/ASAAS_WEBHOOK_SECRET/);
    });

    it('does not block boot in production when ASAAS_API_KEY is not set (Asaas not integrated), even without ASAAS_WEBHOOK_SECRET', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      // This is today's real production state: Asaas isn't integrated yet, so
      // there's no ASAAS_API_KEY anywhere and no ASAAS_WEBHOOK_SECRET either.
      // The boot guard must stay dormant in this case — this is exactly the
      // scenario that motivated gating on apiKey instead of just env.
      vi.stubEnv('ASAAS_API_KEY', '');
      vi.stubEnv('ASAAS_WEBHOOK_SECRET', '');
      stubMinimalBootEnv();

      const { buildServer } = await import('../../api/server.js');

      const app = await buildServer({ logger: false });
      try {
        expect(app).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it('does not block boot in development when ASAAS_WEBHOOK_SECRET is missing', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'development');
      // Explicitly stubbed so this test doesn't inherit whatever ASAAS_API_KEY
      // this process's real .env loaded via an earlier e2e file's
      // `import 'dotenv/config'` — dev env is exempt from the guard regardless.
      vi.stubEnv('ASAAS_API_KEY', 'test-asaas-api-key');
      vi.stubEnv('ASAAS_WEBHOOK_SECRET', '');
      stubMinimalBootEnv();

      const { buildServer } = await import('../../api/server.js');

      const app = await buildServer({ logger: false });
      try {
        expect(app).toBeDefined();
      } finally {
        await app.close();
      }
    });
  });

  describe('runtime fail-closed when webhook secret is not configured', () => {
    it('returns 401 webhook.invalidSecret for /webhooks/asaas when config.asaas.webhookSecret is falsy', async () => {
      vi.resetModules();
      // Deliberately leave NODE_ENV as 'test' (the boot guard is a no-op here — see
      // src/helpers/asaas-webhook-helpers.js SECRET_REQUIRED_ENVIRONMENTS). This is
      // exactly the scenario the runtime fail-closed check defends against: a
      // non-production environment where the boot guard doesn't fire but the secret
      // is still absent at request time. Also stub ASAAS_API_KEY explicitly (rather
      // than leaving it to whatever this process's real .env loaded via an earlier
      // e2e file's `import 'dotenv/config'`) — this test is about the route's
      // runtime behavior, not the boot guard, so it shouldn't depend on that value
      // either way, but leaving it implicit would make the test's inputs non-obvious.
      vi.stubEnv('ASAAS_API_KEY', '');
      vi.stubEnv('ASAAS_WEBHOOK_SECRET', '');
      stubMinimalBootEnv();

      const { buildServer } = await import('../../api/server.js');
      const app = await buildServer({ logger: false });

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/webhooks/asaas',
          headers: {
            'content-type': 'application/json',
            // Any header value — the route must reject before even comparing it,
            // because config.asaas.webhookSecret itself is falsy.
            'asaas-access-token': 'whatever-value',
          },
          payload: { event: 'PAYMENT_CONFIRMED' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({
          error: 'UNAUTHORIZED',
          messageCode: 'webhook.invalidSecret',
        });
      } finally {
        await app.close();
      }
    });
  });
});

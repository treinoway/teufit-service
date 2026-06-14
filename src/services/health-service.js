import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const APP_VERSION = process.env.GIT_COMMIT || packageJson.version;

/**
 * Checks whether the database is reachable by running a minimal query.
 * Returns 'ok' when healthy, 'down' when any error occurs.
 * Never throws — callers receive a degraded status instead.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<'ok' | 'down'>}
 */
async function checkDatabaseStatus(prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'ok';
  } catch {
    return 'down';
  }
}

/**
 * Builds the health check payload. When the DB is unreachable the overall
 * status is 'degraded' and the caller should respond with HTTP 503.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ status: 'ok' | 'degraded', version: string, uptimeSeconds: number, db: 'ok' | 'down' }>}
 */
export async function getHealthStatus(prisma) {
  const db = await checkDatabaseStatus(prisma);
  const status = db === 'ok' ? 'ok' : 'degraded';

  return {
    status,
    version: APP_VERSION,
    uptimeSeconds: process.uptime(),
    db,
  };
}

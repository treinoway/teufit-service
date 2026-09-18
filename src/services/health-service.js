import { createRequire } from 'node:module';
import v8 from 'node:v8';

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
 * V8 heap usage against the process heap limit, so a monitor can alert on heap
 * pressure before an OOM kill (a fatal V8 OOM leaves no application-level trace).
 * heapLimitMb reflects the effective --max-old-space-size.
 *
 * @returns {{ heapUsedMb: number, heapLimitMb: number, heapUsedPercent: number, rssMb: number }}
 */
function getMemoryUsage() {
  const { heapUsed, rss } = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;

  const toMb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

  return {
    heapUsedMb: toMb(heapUsed),
    heapLimitMb: toMb(heapLimit),
    heapUsedPercent: Math.round((heapUsed / heapLimit) * 1000) / 10,
    rssMb: toMb(rss),
  };
}

/**
 * Builds the health check payload. When the DB is unreachable the overall
 * status is 'degraded' and the caller should respond with HTTP 503.
 *
 * Memory is reported but never degrades the status, otherwise Railway would recycle
 * the instance on the very signal we want to observe.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ status: 'ok' | 'degraded', version: string, uptimeSeconds: number, db: 'ok' | 'down', memory: { heapUsedMb: number, heapLimitMb: number, heapUsedPercent: number, rssMb: number } }>}
 */
export async function getHealthStatus(prisma) {
  const db = await checkDatabaseStatus(prisma);
  const status = db === 'ok' ? 'ok' : 'degraded';

  return {
    status,
    version: APP_VERSION,
    uptimeSeconds: process.uptime(),
    db,
    memory: getMemoryUsage(),
  };
}

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

/**
 * Vitest globalSetup for the E2E suite.
 *
 * Spins up a throwaway PostgreSQL 17 container (via Testcontainers) on a random
 * port, applies the Prisma migrations once, then clones the migrated database
 * into one database per Vitest worker (`CREATE DATABASE ... TEMPLATE` is a file
 * copy, far faster than migrating each one). Workers pick theirs by
 * VITEST_POOL_ID in setup-env.js, so e2e files run in parallel without sharing
 * rows or TRUNCATE locks. The container is stopped on teardown.
 *
 * This deliberately never touches the local/dev database or its Docker volume —
 * the old `docker compose down -v` step used to wipe the dev DB. Each run gets a
 * fresh, isolated, disposable Postgres instead.
 */
// Testcontainers only auto-discovers Docker at DOCKER_HOST or the default
// /var/run/docker.sock. Non-standard runtimes (colima, Docker Desktop contexts)
// live elsewhere, so derive the active endpoint from `docker context` when
// DOCKER_HOST is unset. Ryuk (the reaper) is disabled because this globalSetup
// stops the container explicitly in teardown — that also sidesteps socket-mount
// friction on colima.
function ensureDockerEnv() {
  if (!process.env.DOCKER_HOST) {
    try {
      const host = execSync(
        "docker context inspect --format '{{.Endpoints.docker.Host}}'",
        { encoding: 'utf8' },
      ).trim();
      if (host) process.env.DOCKER_HOST = host;
    } catch {
      // Fall back to Testcontainers' own discovery.
    }
  }
  if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  }
}

// Durability is pointless for a disposable database; skipping fsync and WAL
// page writes (and keeping the data dir in RAM) makes every commit cheaper.
const POSTGRES_COMMAND = [
  'postgres',
  '-c', 'fsync=off',
  '-c', 'synchronous_commit=off',
  '-c', 'full_page_writes=off',
  '-c', 'max_connections=200',
];

// Name of the database a given Vitest worker (VITEST_POOL_ID) uses.
function workerDatabaseName(poolId) {
  return `e2e_worker_${poolId}`;
}

// Connection string for `database` on the started container.
function databaseUrlFor(container, database) {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

// Starts the container, migrates once and provides one database URL per worker.
export default async function globalSetup({ provide, config }) {
  ensureDockerEnv();

  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withCommand(POSTGRES_COMMAND)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();

  // Apply migrations to the template DB. The Prisma CLI reads DATABASE_URL via
  // prisma.config.js; passing it explicitly wins over dotenv's .env value.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrlFor(container, container.getDatabase()) },
  });

  const poolIds = Array.from({ length: config.maxWorkers }, (_, index) => index + 1);
  await container.execCommandsSQL(
    poolIds.map((poolId) => `CREATE DATABASE "${workerDatabaseName(poolId)}" TEMPLATE "${container.getDatabase()}"`),
  );

  // Reaches each worker via inject('DATABASE_URLS') in setup-env.js.
  provide(
    'DATABASE_URLS',
    Object.fromEntries(poolIds.map((poolId) => [poolId, databaseUrlFor(container, workerDatabaseName(poolId))])),
  );

  return async () => {
    await container.stop();
  };
}

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

/**
 * Vitest globalSetup for the E2E suite.
 *
 * Spins up a throwaway PostgreSQL 17 container (via Testcontainers) on a random
 * port, applies the Prisma migrations, and hands the connection string to every
 * test worker through `provide()`. The container is stopped on teardown.
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

export default async function globalSetup({ provide }) {
  ensureDockerEnv();

  const container = await new PostgreSqlContainer('postgres:17-alpine').start();

  // getConnectionUri() → postgresql://user:pass@host:port/database (no query).
  const databaseUrl = `${container.getConnectionUri()}?schema=public`;

  // Apply migrations to the ephemeral DB. The Prisma CLI reads DATABASE_URL via
  // prisma.config.js; passing it explicitly wins over dotenv's .env value.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Reaches each worker via inject('DATABASE_URL') in setup-env.js.
  provide('DATABASE_URL', databaseUrl);

  return async () => {
    await container.stop();
  };
}

import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const ADMIN_APPLICATION_NAME = 'teufit-manager';

// Builds the libpq session options that cap query time and forbid writes.
function buildSessionOptions(statementTimeoutMs) {
  return `-c statement_timeout=${statementTimeoutMs} -c default_transaction_read_only=on -c idle_in_transaction_session_timeout=${statementTimeoutMs}`;
}

// Creates a Prisma client on its own small, read-only, time-limited pool (isolated from the app pool).
export function createAdminPrisma({ connectionString, max, statementTimeoutMs }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: statementTimeoutMs,
    application_name: ADMIN_APPLICATION_NAME,
    options: buildSessionOptions(statementTimeoutMs),
  });
  const { PrismaClient } = prismaClient;
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
}

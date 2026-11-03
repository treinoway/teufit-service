import { describe, it, expect, vi, beforeEach } from 'vitest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import prismaClient from '@prisma/client';

const ADMIN_URL = 'postgresql://admin:pw@replica:5432/app';
const STATEMENT_TIMEOUT_MS = 1234;
const PoolMock = pg.Pool;

vi.mock('pg', () => ({ default: { Pool: vi.fn() } }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: vi.fn() }));
vi.mock('@prisma/client', () => ({ default: { PrismaClient: vi.fn() } }));

// Builds the admin client and returns the options handed to pg.Pool.
async function buildPoolOptions() {
  vi.resetModules();
  const { createAdminPrisma } = await import('../src/db-admin.js');
  createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  return PoolMock.mock.calls[0][0];
}

describe('createAdminPrisma timeouts', () => {
  beforeEach(() => {
    PoolMock.mockImplementation(function Pool() {});
    PrismaPg.mockImplementation(function Adapter() {});
    prismaClient.PrismaClient.mockImplementation(function Client() {});
  });

  it('should set connectionTimeoutMillis equal to statementTimeoutMs', async () => {
    const options = await buildPoolOptions();

    expect(options.connectionTimeoutMillis).toBe(STATEMENT_TIMEOUT_MS);
  });

  it('should set idle_in_transaction_session_timeout to statementTimeoutMs', async () => {
    const options = await buildPoolOptions();

    expect(options.options).toContain(`-c idle_in_transaction_session_timeout=${STATEMENT_TIMEOUT_MS}`);
  });
});

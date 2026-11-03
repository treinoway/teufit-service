import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import prismaClient from '@prisma/client';

const ADMIN_URL = 'postgresql://admin:pw@replica:5432/app';
const APP_URL = 'postgresql://app:pw@primary:5432/app';
const PoolMock = pg.Pool;
const PrismaPgMock = PrismaPg;
const PrismaClientMock = prismaClient.PrismaClient;
const APPLICATION_NAME = 'teufit-manager';
const DEFAULT_POOL_MAX = 2;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

vi.mock('pg', () => ({ default: { Pool: vi.fn() } }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: vi.fn() }));
vi.mock('@prisma/client', () => ({ default: { PrismaClient: vi.fn() } }));

// Imports the admin client factory fresh so module state never leaks between tests.
async function loadFactory() {
  vi.resetModules();
  return (await import('../src/db-admin.js')).createAdminPrisma;
}

// Imports the merged config fresh so env changes are re-read.
async function loadConfig() {
  vi.resetModules();
  return (await import('../config/index.js')).default;
}

describe('createAdminPrisma', () => {
  beforeEach(() => {
    PoolMock.mockImplementation(function Pool(options) {
      this.options = options;
    });
    PrismaPgMock.mockImplementation(function PrismaPg(pool) {
      this.pool = pool;
    });
    PrismaClientMock.mockImplementation(function PrismaClient(options) {
      this.options = options;
    });
  });

  it('should create a dedicated pg.Pool on the given connection string', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionString: ADMIN_URL });
  });

  it('should cap the pool at the given max', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 3, statementTimeoutMs: 5000 });

    expect(PoolMock.mock.calls[0][0].max).toBe(3);
  });

  it('should tag connections with application_name teufit-manager', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(PoolMock.mock.calls[0][0].application_name).toBe(APPLICATION_NAME);
  });

  it('should set the session statement_timeout from statementTimeoutMs', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 1234 });

    expect(PoolMock.mock.calls[0][0].options).toContain('-c statement_timeout=1234');
  });

  it('should force read-only transactions on every session', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(PoolMock.mock.calls[0][0].options).toContain('-c default_transaction_read_only=on');
  });

  it('should wrap the dedicated pool in a PrismaPg adapter', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(PrismaPgMock.mock.calls[0][0]).toBe(PoolMock.mock.instances[0]);
  });

  it('should build the PrismaClient on that adapter', async () => {
    const createAdminPrisma = await loadFactory();

    createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(PrismaClientMock.mock.calls[0][0].adapter).toBe(PrismaPgMock.mock.instances[0]);
  });

  it('should return the created client', async () => {
    const createAdminPrisma = await loadFactory();

    const client = createAdminPrisma({ connectionString: ADMIN_URL, max: 2, statementTimeoutMs: 5000 });

    expect(client).toBe(PrismaClientMock.mock.instances[0]);
  });
});

describe('admin database config defaults', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', APP_URL);
    vi.stubEnv('ADMIN_DATABASE_URL', '');
    vi.stubEnv('ADMIN_DB_POOL_MAX', '');
    vi.stubEnv('ADMIN_DB_STATEMENT_TIMEOUT_MS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should fall back to DATABASE_URL when ADMIN_DATABASE_URL is not set', async () => {
    const config = await loadConfig();

    expect(config.adminDb.url).toBe(APP_URL);
  });

  it('should prefer ADMIN_DATABASE_URL when set', async () => {
    vi.stubEnv('ADMIN_DATABASE_URL', ADMIN_URL);

    const config = await loadConfig();

    expect(config.adminDb.url).toBe(ADMIN_URL);
  });

  it('should default the pool max to 2', async () => {
    const config = await loadConfig();

    expect(config.adminDb.poolMax).toBe(DEFAULT_POOL_MAX);
  });

  it('should read the pool max from ADMIN_DB_POOL_MAX as a number', async () => {
    vi.stubEnv('ADMIN_DB_POOL_MAX', '4');

    const config = await loadConfig();

    expect(config.adminDb.poolMax).toBe(4);
  });

  it('should default the statement timeout to 5000 ms', async () => {
    const config = await loadConfig();

    expect(config.adminDb.statementTimeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  it('should read the statement timeout from ADMIN_DB_STATEMENT_TIMEOUT_MS as a number', async () => {
    vi.stubEnv('ADMIN_DB_STATEMENT_TIMEOUT_MS', '750');

    const config = await loadConfig();

    expect(config.adminDb.statementTimeoutMs).toBe(750);
  });

  it('should rate limit manager routes to 60 requests per minute per user', async () => {
    const config = await loadConfig();

    expect(config.rateLimit.adminManager).toEqual({ max: 60, timeWindow: '1 minute' });
  });
});

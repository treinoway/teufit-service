import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: GET /health', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns 200 with status ok when the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 200 without requiring an Authorization header', async () => {
    // /health is public — no bearer token needed
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('returns 503 with status degraded when the database is unreachable', async () => {
    // Temporarily break the prisma query so we can exercise the degraded path.
    // prisma (src/db.js) is a Proxy in Prisma 7 (driver adapter) — vi.spyOn cannot
    // spy on it (getOwnPropertyDescriptor returns value: undefined), so we save the
    // original and assign a mock directly instead.
    const { prisma } = await import('../../src/db.js');
    const originalQueryRaw = prisma.$queryRaw;

    prisma.$queryRaw = vi.fn().mockRejectedValueOnce(new Error('simulated db failure'));

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);

      const body = response.json();
      expect(body.status).toBe('degraded');
      expect(body.db).toBe('down');
      // Must not expose internals
      expect(body.error).toBeUndefined();
      expect(body.stack).toBeUndefined();
    } finally {
      // Restore original behavior regardless of test outcome
      prisma.$queryRaw = originalQueryRaw;
    }
  });

  it('response body does not contain stack trace or error internals on db failure', async () => {
    const { prisma } = await import('../../src/db.js');
    const originalQueryRaw = prisma.$queryRaw;

    prisma.$queryRaw = vi.fn().mockRejectedValueOnce(new Error('internal db detail'));

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      const body = response.json();

      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('cause');
      // Internal error message must never leak
      expect(JSON.stringify(body)).not.toContain('internal db detail');
    } finally {
      prisma.$queryRaw = originalQueryRaw;
    }
  });
});

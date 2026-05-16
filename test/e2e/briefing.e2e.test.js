/**
 * E2E tests for GET /trainer/briefing
 *
 * These tests require a live database (DATABASE_URL env var).
 * They are skipped in CI environments without a DB connection.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: GET /trainer/briefing', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Auth helpers ────────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `e2e+briefing-trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    const becomeTrainerRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerRes.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerRes.json();

    return { userId, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `e2e+briefing-student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { token: { accessToken } } = signupRes.json();

    return { accessToken };
  }

  // ─── Tests ───────────────────────────────────────────────────────────────────

  it('returns 401 when no auth header is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    // error and messageCode are always present per the unified error contract
    expect(body.error).toBeDefined();
    expect(body.messageCode).toBeDefined();
    expect(body.message).toBeDefined();
  });

  it('returns 403 when authenticated as a student (no TRAINER role)', async () => {
    const { accessToken } = await createStudentWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.message).toBeDefined();
  });

  it('returns 200 with all-zero KPIs for a fresh trainer with no roster', async () => {
    const { accessToken } = await createTrainerWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.activeStudents).toBe(0);
    expect(body.returningThisWeek).toBe(0);
    expect(body.stagnantProgress).toBe(0);
    expect(body.inactiveStudents).toBe(0);
    expect(body.overallAdherence).toBe('0.00');
    expect(body.adherenceDeltaPp).toBe('0.00');
    expect(body.computedAt).toBeDefined();
    // computedAt is a valid ISO timestamp
    expect(() => new Date(body.computedAt)).not.toThrow();
  });

  it('returns non-NaN adherence values for an empty roster', async () => {
    const { accessToken } = await createTrainerWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Number.isNaN(parseFloat(body.overallAdherence))).toBe(false);
    expect(Number.isNaN(parseFloat(body.adherenceDeltaPp))).toBe(false);
  });

  it('returns cached snapshot on second call (same computedAt)', async () => {
    const { accessToken } = await createTrainerWithToken();

    const firstRes = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json();

    const secondRes = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json();

    // Same computedAt means snapshot was reused, not recomputed
    expect(secondBody.computedAt).toBe(firstBody.computedAt);
  });

  it('recomputes after markBriefingDirty (computedAt is updated)', async () => {
    const { accessToken, userId } = await createTrainerWithToken();

    // First call creates the snapshot
    const firstRes = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstComputedAt = firstRes.json().computedAt;

    // Resolve trainer.id from userId and mark dirty directly via DB
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });
    await prisma.trainerBriefingSnapshot.updateMany({
      where: { trainerId: trainer.id },
      data: { isDirty: true },
    });

    // Give enough time (1ms) to ensure next computedAt will differ
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Second call should recompute
    const secondRes = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(secondRes.statusCode).toBe(200);
    const secondComputedAt = secondRes.json().computedAt;

    expect(secondComputedAt).not.toBe(firstComputedAt);
  });

  it('response shape matches the documented API contract', async () => {
    const { accessToken } = await createTrainerWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trainer/briefing',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // All expected keys are present
    expect(body).toHaveProperty('activeStudents');
    expect(body).toHaveProperty('returningThisWeek');
    expect(body).toHaveProperty('stagnantProgress');
    expect(body).toHaveProperty('inactiveStudents');
    expect(body).toHaveProperty('overallAdherence');
    expect(body).toHaveProperty('adherenceDeltaPp');
    expect(body).toHaveProperty('computedAt');

    // Integer fields are integers
    expect(Number.isInteger(body.activeStudents)).toBe(true);
    expect(Number.isInteger(body.returningThisWeek)).toBe(true);
    expect(Number.isInteger(body.stagnantProgress)).toBe(true);
    expect(Number.isInteger(body.inactiveStudents)).toBe(true);

    // Decimal fields are strings with 2 decimal places
    expect(typeof body.overallAdherence).toBe('string');
    expect(typeof body.adherenceDeltaPp).toBe('string');
    expect(body.overallAdherence).toMatch(/^-?\d+\.\d{2}$/);
    expect(body.adherenceDeltaPp).toMatch(/^-?\d+\.\d{2}$/);
  });
});

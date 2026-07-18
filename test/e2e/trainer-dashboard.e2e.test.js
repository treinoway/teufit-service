/**
 * E2E tests for GET /trainer/dashboard
 *
 * These tests require a live database (DATABASE_URL env var).
 * They are skipped in CI environments without a DB connection.
 *
 * Fixtures for StudentSubscription / SubscriptionPayment / TrainingProtocol
 * are created directly via Prisma (not through the mutation routes) so tests
 * have exact control over dueDate / cycleEndDate / expirationDate boundaries
 * — the same pattern used in workouts-today.e2e.test.js for protocols.
 */

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { SubscriptionStatus, PaymentStatus } from '../../src/constants/subscription.js';
import { getDateOnlyAsMidnightUtc, addDaysMs } from '../../src/helpers/date-helpers.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const SIGNED_PERCENTAGE_PATTERN = /^-?\d+(\.\d{1,2})?$/;

e2eDescribe('e2e: GET /trainer/dashboard', () => {
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

  // ─── Date fixtures ───────────────────────────────────────────────────────────

  function daysFromToday(days) {
    const today = getDateOnlyAsMidnightUtc(new Date());
    return addDaysMs(today, days);
  }

  // ─── Auth helpers ────────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `e2e+dashboard-trainer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `e2e+dashboard-student-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    return { userId, accessToken };
  }

  // ─── Fixture helpers (direct Prisma — see file docstring) ───────────────────

  async function createPlan(trainerId, overrides = {}) {
    return prisma.subscriptionPlan.create({
      data: {
        trainerId,
        name: 'Plano E2E Dashboard',
        recurrence: 'monthly',
        price: 100,
        ...overrides,
      },
    });
  }

  async function createSubscription(trainerId, studentId, planId, overrides = {}) {
    return prisma.studentSubscription.create({
      data: {
        trainerId,
        studentId,
        planId,
        recurrence: 'monthly',
        price: 100,
        startDate: daysFromToday(-60),
        status: SubscriptionStatus.ACTIVE,
        ...overrides,
      },
    });
  }

  async function createPayment(subscriptionId, overrides = {}) {
    return prisma.subscriptionPayment.create({
      data: {
        subscriptionId,
        cycleStartDate: daysFromToday(-30),
        cycleEndDate: daysFromToday(0),
        dueDate: daysFromToday(0),
        amount: 100,
        status: PaymentStatus.PENDING,
        ...overrides,
      },
    });
  }

  async function createProtocol(trainerId, assigneeId, overrides = {}) {
    return prisma.trainingProtocol.create({
      data: {
        trainerId,
        assigneeId,
        name: 'Protocolo E2E Dashboard',
        status: 'active',
        startDate: daysFromToday(-60),
        ...overrides,
      },
    });
  }

  function getUrl() {
    return '/trainer/dashboard';
  }

  // ─── Auth / authorization ────────────────────────────────────────────────────

  it('returns 401 when no auth header is provided', async () => {
    const res = await app.inject({ method: 'GET', url: getUrl() });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.messageCode).toBeDefined();
    expect(body.message).toBeDefined();
  });

  it('returns 403 when authenticated as a student (no TRAINER role)', async () => {
    const { accessToken } = await createStudentWithToken();

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.messageCode).toBeDefined();
    expect(body.message).toBeDefined();
  });

  it('returns 404 with trainer.notFound messageCode when the authenticated user has no Trainer profile', async () => {
    const { userId, accessToken } = await createTrainerWithToken();

    // Simulate a TRAINER-role token whose Trainer profile no longer exists —
    // the JWT already carries the role, but the service resolves the profile
    // from the DB on every call.
    await prisma.trainer.delete({ where: { userId } });

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe('NOT_FOUND');
    expect(body.messageCode).toBe('trainer.notFound');
    expect(body.message).toBeDefined();
  });

  // ─── Happy path / response shape ─────────────────────────────────────────────

  describe('200 response shape', () => {
    it('returns all-zero KPIs for a fresh trainer with no roster, plans, or protocols', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.plans).toEqual({ expiredCount: 0, renewingSoonCount: 0 });
      expect(body.routines).toEqual({ expiredCount: 0, expiringSoonCount: 0 });
      expect(body.finance).toEqual({
        monthReceived: '0.00',
        totalReceived: '0.00',
        overdueCount: 0,
        overdueAmount: '0.00',
      });
      expect(body.engagement.inactiveStudentsCount).toBe(0);
      expect(body.engagement.adherenceMonthPct).toBe('0.00');
      expect(body.engagement.adherenceDeltaPp).toBe('0.00');
      expect(body.engagement.weekPrCount).toBe(0);
    });

    it('matches the documented contract: money/percentage fields are pattern-valid strings, generatedAt is ISO', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        amount: 199.9,
      });
      await createProtocol(trainerId, studentId);

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body).toHaveProperty('plans');
      expect(body).toHaveProperty('routines');
      expect(body).toHaveProperty('finance');
      expect(body).toHaveProperty('engagement');
      expect(body).toHaveProperty('generatedAt');

      expect(Number.isInteger(body.plans.expiredCount)).toBe(true);
      expect(Number.isInteger(body.plans.renewingSoonCount)).toBe(true);
      expect(Number.isInteger(body.routines.expiredCount)).toBe(true);
      expect(Number.isInteger(body.routines.expiringSoonCount)).toBe(true);
      expect(Number.isInteger(body.finance.overdueCount)).toBe(true);
      expect(Number.isInteger(body.engagement.inactiveStudentsCount)).toBe(true);
      expect(Number.isInteger(body.engagement.weekPrCount)).toBe(true);

      expect(body.finance.monthReceived).toMatch(MONEY_PATTERN);
      expect(body.finance.totalReceived).toMatch(MONEY_PATTERN);
      expect(body.finance.overdueAmount).toMatch(MONEY_PATTERN);
      expect(body.engagement.adherenceMonthPct).toMatch(MONEY_PATTERN);
      expect(body.engagement.adherenceDeltaPp).toMatch(SIGNED_PERCENTAGE_PATTERN);

      expect(() => new Date(body.generatedAt).toISOString()).not.toThrow();
      expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);

      // The paid payment (this month) should be reflected in monthReceived/totalReceived.
      expect(body.finance.monthReceived).toBe('199.90');
      expect(body.finance.totalReceived).toBe('199.90');
    });
  });

  // ─── plans.renewingSoonCount — 7-day inclusive boundary ──────────────────────

  describe('plans.renewingSoonCount boundary', () => {
    it('counts a subscription whose cycleEndDate is exactly today+7d (inclusive)', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, {
        cycleEndDate: daysFromToday(7),
        dueDate: daysFromToday(7),
      });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().plans.renewingSoonCount).toBe(1);
      expect(res.json().plans.expiredCount).toBe(0);
    });

    it('does NOT count an active subscription with zero materialized payments toward renewingSoonCount or expiredCount', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(trainerId);
      await createSubscription(trainerId, studentId, plan.id); // no payments created

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().plans.renewingSoonCount).toBe(0);
      expect(res.json().plans.expiredCount).toBe(0);
    });
  });

  // ─── routines.expiringSoonCount — 7-day inclusive boundary ───────────────────

  describe('routines.expiringSoonCount boundary', () => {
    it('counts a protocol whose expirationDate is exactly today+7d (inclusive) — same convention as plans.renewingSoonCount', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await createProtocol(trainerId, studentId, { expirationDate: daysFromToday(7) });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().routines.expiringSoonCount).toBe(1);
      expect(res.json().routines.expiredCount).toBe(0);
    });

    it('excludes a protocol with expirationDate=null from both expiredCount and expiringSoonCount', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await createProtocol(trainerId, studentId, { expirationDate: null });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().routines.expiredCount).toBe(0);
      expect(res.json().routines.expiringSoonCount).toBe(0);
    });

    it('counts a protocol expired strictly before today (exclusive boundary)', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await createProtocol(trainerId, studentId, { expirationDate: daysFromToday(-1) });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().routines.expiredCount).toBe(1);
      expect(res.json().routines.expiringSoonCount).toBe(0);
    });
  });

  // ─── finance ──────────────────────────────────────────────────────────────────

  describe('finance', () => {
    it('returns "0.00" strings (never null) for a trainer with zero payments', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { finance } = res.json();
      expect(finance.monthReceived).toBe('0.00');
      expect(finance.totalReceived).toBe('0.00');
      expect(finance.overdueAmount).toBe('0.00');
      expect(finance.overdueCount).toBe(0);
    });

    it('a single active subscription with 3 overdue pending payments: plans.expiredCount=1 but finance.overdueCount=3', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);

      await createPayment(subscription.id, { dueDate: daysFromToday(-1), amount: 100 });
      await createPayment(subscription.id, { dueDate: daysFromToday(-2), amount: 150 });
      await createPayment(subscription.id, { dueDate: daysFromToday(-3), amount: 200 });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.plans.expiredCount).toBe(1);
      expect(body.finance.overdueCount).toBe(3);
      expect(body.finance.overdueAmount).toBe('450.00');
    });

    it('a cancelled subscription with an overdue payment does NOT count toward plans.expiredCount but DOES count toward finance.overdueCount/overdueAmount', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id, {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      });
      await createPayment(subscription.id, { dueDate: daysFromToday(-5), amount: 250 });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.plans.expiredCount).toBe(0);
      expect(body.finance.overdueCount).toBe(1);
      expect(body.finance.overdueAmount).toBe('250.00');
    });
  });

  // ─── engagement ────────────────────────────────────────────────────────────────

  describe('engagement', () => {
    it('weekPrCount is computed live from TrainerStudent.currentPrAt within the last 7 days', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: recentStudentId } = await createStudentWithToken();
      const { userId: staleStudentId } = await createStudentWithToken();

      await prisma.trainerStudent.create({
        data: { trainerId, studentId: recentStudentId, currentPrAt: new Date(), currentPrLoad: 100 },
      });
      await prisma.trainerStudent.create({
        data: { trainerId, studentId: staleStudentId, currentPrAt: daysFromToday(-10), currentPrLoad: 80 },
      });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().engagement.weekPrCount).toBe(1);
    });

    it('excludes a student blocked by the trainer seat quota (activeOnPlan: false) from weekPrCount even with a recent PR', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: activeStudentId } = await createStudentWithToken();
      const { userId: blockedStudentId } = await createStudentWithToken();

      // Active-on-plan student with a recent PR — counts.
      await prisma.trainerStudent.create({
        data: { trainerId, studentId: activeStudentId, currentPrAt: new Date(), currentPrLoad: 100 },
      });
      // Blocked-by-quota student (activeOnPlan: false) — still trains and
      // hits PRs (activeOnPlan only gates the trainer's own writes), but
      // must NOT count here: the other 3 engagement.* fields are sourced
      // from the briefing snapshot's activeOnPlan-filtered roster, and
      // weekPrCount has to match that same population.
      await prisma.trainerStudent.create({
        data: {
          trainerId,
          studentId: blockedStudentId,
          activeOnPlan: false,
          currentPrAt: new Date(),
          currentPrLoad: 120,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().engagement.weekPrCount).toBe(1);
    });

    it('reads inactiveStudentsCount, adherenceMonthPct, and adherenceDeltaPp (including negative) from the cached briefing snapshot, not recomputed', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();

      // First call creates the snapshot (no roster → all zeros).
      const firstRes = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(firstRes.statusCode).toBe(200);

      // Directly overwrite the cached snapshot with distinct, negative-delta
      // values and keep isDirty=false so the dashboard reads it as-is instead
      // of recomputing from live session/adherence data.
      await prisma.trainerBriefingSnapshot.update({
        where: { trainerId },
        data: {
          inactiveStudents: 7,
          overallAdherence: 61.5,
          adherenceDeltaPp: -3.2,
          isDirty: false,
        },
      });

      const secondRes = await app.inject({
        method: 'GET',
        url: getUrl(),
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(secondRes.statusCode).toBe(200);
      const { engagement } = secondRes.json();
      expect(engagement.inactiveStudentsCount).toBe(7);
      expect(engagement.adherenceMonthPct).toBe('61.50');
      expect(engagement.adherenceDeltaPp).toBe('-3.20');
    });
  });
});

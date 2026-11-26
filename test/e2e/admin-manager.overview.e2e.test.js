import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { createAdminWithToken, createTrainerWithToken, createStudentWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_PLAN_TIER_ORDER, getBillingMonth } from '../../src/constants/platform-plan.js';
import { LLM_PROVIDERS, AI_MODELS } from '../../src/constants/ai.js';
import { AI_MODEL_PRICES_USD_PER_MTOK } from '../../src/constants/ai-pricing.js';
import { OVERVIEW_PERIODS } from '../../src/constants/admin-manager.js';
import { WorkoutSessionStatus } from '../../src/constants/training.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../../src/constants/feedback.js';
import { BUSINESS_TIMEZONE } from '../../src/constants/subscription.js';
import { weekStartFor } from '../../src/helpers/consistency-week.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const OVERVIEW_URL = '/admin/manager/overview';
const PENDING_URL = '/admin/manager/pending';
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_MTOK = 1_000_000;
const WEEK_COUNT = 8;
const TOP_LIMIT = 5;
const PAST_BILLING_MONTH = '2026-01';
const UNKNOWN_MODEL = 'model-without-price';
const PERIOD_DAYS = [
  [OVERVIEW_PERIODS.DAYS_7, 7],
  [OVERVIEW_PERIODS.DAYS_30, 30],
  [OVERVIEW_PERIODS.DAYS_90, 90],
];
const { FREE, PRO, PLATINUM, DIAMOND, BETA } = PLATFORM_PLAN_TIERS;
const ZERO_KPI = { current: 0, previous: 0 };
const TIED_INDEXES = [3, 4];

// Returns the instant `days` days before now (fractions allowed).
function daysAgo(days) {
  return new Date(Date.now() - days * MS_PER_DAY);
}

// Sends an authenticated GET (no authorization header when the token is null).
function authGet(app, url, accessToken) {
  return app.inject({ method: 'GET', url, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
}

// Fetches the overview for the period (default period when omitted) and returns the parsed body.
async function fetchOverview(app, accessToken, period) {
  const response = await authGet(app, period ? `${OVERVIEW_URL}?period=${period}` : OVERVIEW_URL, accessToken);
  expect(response.statusCode).toBe(OK_STATUS);
  return response.json();
}

// Moves a user's (and its trainer row's, when present) createdAt and optional soft-delete marks.
async function placeUser(userId, { createdAt, userDeletedAt = null, trainerDeletedAt = null }) {
  await prisma.user.update({ where: { id: userId }, data: { createdAt, deletedAt: userDeletedAt } });
  await prisma.trainer.updateMany({ where: { userId }, data: { createdAt, deletedAt: trainerDeletedAt } });
}

// Creates a trainer placed at createdAt, optionally soft-deleted, and returns the helper record.
async function createPlacedTrainer(app, { createdAt = new Date(), firstName, lastName, userDeleted = false, trainerDeleted = false } = {}) {
  const trainer = await createTrainerWithToken(app, { firstName, lastName });
  await placeUser(trainer.userId, {
    createdAt,
    userDeletedAt: userDeleted ? new Date() : null,
    trainerDeletedAt: trainerDeleted ? new Date() : null,
  });
  return trainer;
}

// Creates a student placed at createdAt, linked to the given trainers, optionally soft-deleted.
async function createPlacedStudent(app, { createdAt = new Date(), trainerIds = [], deleted = false } = {}) {
  const student = await createStudentWithToken(app);
  for (const trainerId of trainerIds) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId: student.userId } });
  }
  await placeUser(student.userId, { createdAt, userDeletedAt: deleted ? new Date() : null });
  return student;
}

// Creates a protocol with one training owned by the trainer for the student and returns the training id.
async function createTrainingFor(trainerId, studentId) {
  const protocol = await prisma.trainingProtocol.create({
    data: { trainerId, assigneeId: studentId, name: 'Protocolo', startDate: daysAgo(200) },
  });
  const training = await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: 'Treino A', category: 'strength', order: 0 },
  });
  return training.id;
}

// Creates a workout session with the given status, finish instant and soft-delete mark.
async function createSession(trainingId, userId, { status = WorkoutSessionStatus.COMPLETED, finishedAt = null, deletedAt = null, startedAt }) {
  return prisma.workoutSession.create({
    data: {
      trainingId,
      userId,
      status,
      startedAt: startedAt ?? new Date((finishedAt ?? new Date()).getTime() - MS_PER_HOUR),
      finishedAt,
      deletedAt,
    },
  });
}

// Stores one iArnold token usage row.
async function seedUsage(trainerId, { model = AI_MODELS.ANTHROPIC, billingMonth = getBillingMonth(), ...tokens }) {
  return prisma.aiTokenUsage.create({
    data: {
      trainerId,
      provider: LLM_PROVIDERS.ANTHROPIC,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      llmCalls: 1,
      billingMonth,
      ...tokens,
    },
  });
}

// Computes the expected USD cost of known-model token counters from the exported price table, rounded to cents.
function expectedCostUsd(counters) {
  const raw = counters.reduce((sum, row) => {
    const price = AI_MODEL_PRICES_USD_PER_MTOK[row.model];
    if (!price) return sum;
    return sum + (row.inputTokens * price.input + row.outputTokens * price.output
      + row.cacheReadTokens * price.cacheRead + row.cacheWriteTokens * price.cacheWrite) / MS_PER_MTOK;
  }, 0);
  return Math.round(raw * 100) / 100;
}

// Fills the four token counters of a usage row with zero defaults.
function tokenRow(model, tokens) {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...tokens };
}

// Creates a trainer invite with the given status and expiry.
async function createInvite(invitedByUserId, { status, expiresAt }) {
  return prisma.trainerInvite.create({
    data: {
      email: `invite-${crypto.randomUUID()}@example.com`,
      codeHash: crypto.randomBytes(16).toString('hex'),
      status,
      invitedByUserId,
      expiresAt,
    },
  });
}

// Creates a trainer feedback with the given status.
async function createFeedback(trainerId, status) {
  return prisma.trainerFeedback.create({
    data: { trainerId, category: FEEDBACK_CATEGORIES.SUGGESTION, message: 'mensagem', status },
  });
}

// Returns the 8 expected Sao Paulo Monday week starts (oldest first) for now, computed independently.
function expectedWeekStarts() {
  const monday = weekStartFor(new Date(), BUSINESS_TIMEZONE);
  const mondayUtc = Date.UTC(monday.year, monday.month - 1, monday.day);
  return Array.from({ length: WEEK_COUNT }, (_, index) => (
    new Date(mondayUtc - (WEEK_COUNT - 1 - index) * 7 * MS_PER_DAY).toISOString().slice(0, 10)
  ));
}

// Asserts a body follows the unified error contract.
function expectErrorContract(body, { error, messageCode }) {
  expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
  expect(body).toHaveProperty('details');
}

e2eDescribe('e2e: admin manager overview', () => {
  let app;
  let admin;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    admin = await createAdminWithToken(app);
  });

  describe('access and period (AC 1)', () => {
    it('should default to the 30d period', async () => {
      const body = await fetchOverview(app, admin.accessToken);

      expect(body.period).toBe(OVERVIEW_PERIODS.DAYS_30);
    });

    it.each(PERIOD_DAYS)('should build the %s windows ending at request time', async (period, days) => {
      const before = Date.now();
      const body = await fetchOverview(app, admin.accessToken, period);
      const after = Date.now();

      const to = Date.parse(body.range.to);
      expect(body.period).toBe(period);
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(after);
      expect(to - Date.parse(body.range.from)).toBe(days * MS_PER_DAY);
      expect(body.previousRange.to).toBe(body.range.from);
      expect(to - Date.parse(body.previousRange.from)).toBe(2 * days * MS_PER_DAY);
    });

    it('should return a generatedAt ISO timestamp', async () => {
      const body = await fetchOverview(app, admin.accessToken);

      expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    });

    it.each(['14d', '1y', '0d', ''])('should answer 400 VALIDATION_ERROR for period=%s', async (period) => {
      const response = await authGet(app, `${OVERVIEW_URL}?period=${period}`, admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 403 auth.forbidden to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await authGet(app, OVERVIEW_URL, accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('should answer 403 to a student', async () => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await authGet(app, OVERVIEW_URL, accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
    });

    it('should answer 401 without a token', async () => {
      const response = await authGet(app, OVERVIEW_URL, null);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });
  });

  describe('empty platform', () => {
    let body;

    beforeEach(async () => {
      body = await fetchOverview(app, admin.accessToken);
    });

    it('should report zero KPIs', () => {
      expect(body.kpis).toEqual({
        newTrainers: ZERO_KPI,
        newStudents: ZERO_KPI,
        activeTrainers: ZERO_KPI,
        completedSessions: ZERO_KPI,
      });
    });

    it('should report 8 empty weeks', () => {
      expect(body.weeklySignups).toEqual(expectedWeekStarts().map((weekStart) => ({ weekStart, trainers: 0, students: 0 })));
    });

    it('should report a zeroed, complete iArnold block for the current billing month', () => {
      expect(body.ai).toEqual({
        month: getBillingMonth(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        interactions: 0,
        trainers: 0,
        estimatedCostUsd: 0,
        costComplete: true,
        topTrainers: [],
      });
    });

    it('should list every tier with zero trainers', () => {
      expect(body.plans).toEqual(PLATFORM_PLAN_TIER_ORDER.map((tier) => ({ tier, count: 0 })));
    });

    it('should report no pending items and no latest trainers', () => {
      expect(body.pending).toEqual({ pendingInvites: 0, newFeedbacks: 0, trainersWithoutStudents: 0 });
      expect(body.latestTrainers).toEqual([]);
    });
  });

  describe('new trainers (AC 2)', () => {
    beforeEach(async () => {
      await createPlacedTrainer(app, { createdAt: daysAgo(3) });
      await createPlacedTrainer(app, { createdAt: daysAgo(45) });
      await createPlacedTrainer(app, { createdAt: daysAgo(100) });
      await createPlacedTrainer(app, { createdAt: daysAgo(3), trainerDeleted: true });
      await createPlacedTrainer(app, { createdAt: daysAgo(45), userDeleted: true });
    });

    it('should count only live trainers in the 30d windows', async () => {
      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_30);

      expect(body.kpis.newTrainers).toEqual({ current: 1, previous: 1 });
    });

    it('should count only live trainers in the 90d windows', async () => {
      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_90);

      expect(body.kpis.newTrainers).toEqual({ current: 2, previous: 1 });
    });

    it('should count only live trainers in the 7d windows', async () => {
      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_7);

      expect(body.kpis.newTrainers).toEqual({ current: 1, previous: 0 });
    });
  });

  describe('new students (AC 3)', () => {
    beforeEach(async () => {
      const first = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const second = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const studentTrainer = await createPlacedTrainer(app, { createdAt: daysAgo(3) });
      await prisma.trainerStudent.create({ data: { trainerId: first.trainerId, studentId: studentTrainer.userId } });
      await createPlacedStudent(app, { createdAt: daysAgo(3), trainerIds: [first.trainerId, second.trainerId] });
      await createPlacedStudent(app, { createdAt: daysAgo(45), trainerIds: [first.trainerId] });
      await createPlacedStudent(app, { createdAt: daysAgo(100), trainerIds: [first.trainerId] });
      await createPlacedStudent(app, { createdAt: daysAgo(3) });
      await createPlacedStudent(app, { createdAt: daysAgo(3), trainerIds: [first.trainerId], deleted: true });
    });

    it('should count live linked non-trainer users once per window', async () => {
      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_30);

      expect(body.kpis.newStudents).toEqual({ current: 1, previous: 1 });
    });

    it('should widen the count with the 90d period', async () => {
      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_90);

      expect(body.kpis.newStudents).toEqual({ current: 2, previous: 1 });
    });
  });

  describe('completed sessions and active trainers (AC 4)', () => {
    let body;

    beforeEach(async () => {
      const busy = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const quiet = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const busyStudent = await createPlacedStudent(app, { createdAt: daysAgo(200), trainerIds: [busy.trainerId] });
      const quietStudent = await createPlacedStudent(app, { createdAt: daysAgo(200), trainerIds: [quiet.trainerId] });
      const busyTraining = await createTrainingFor(busy.trainerId, busyStudent.userId);
      const quietTraining = await createTrainingFor(quiet.trainerId, quietStudent.userId);
      await createSession(busyTraining, busyStudent.userId, { finishedAt: daysAgo(3) });
      await createSession(busyTraining, busyStudent.userId, { finishedAt: daysAgo(2) });
      await createSession(busyTraining, busyStudent.userId, { finishedAt: daysAgo(45) });
      await createSession(busyTraining, busyStudent.userId, { status: WorkoutSessionStatus.IN_PROGRESS, startedAt: daysAgo(1) });
      await createSession(busyTraining, busyStudent.userId, { status: WorkoutSessionStatus.ABANDONED, finishedAt: daysAgo(3) });
      await createSession(busyTraining, busyStudent.userId, { finishedAt: daysAgo(3), deletedAt: daysAgo(1) });
      await createSession(quietTraining, quietStudent.userId, { finishedAt: daysAgo(4) });
      await createSession(quietTraining, quietStudent.userId, { finishedAt: daysAgo(100) });
      body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_30);
    });

    it('should count only live completed sessions finished in each window', () => {
      expect(body.kpis.completedSessions).toEqual({ current: 3, previous: 1 });
    });

    it('should count distinct trainers owning a completed session in each window', () => {
      expect(body.kpis.activeTrainers).toEqual({ current: 2, previous: 1 });
    });
  });

  describe('active trainers exclude deleted trainers (AC 4)', () => {
    it('should not count a soft-deleted trainer as active', async () => {
      const gone = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const student = await createPlacedStudent(app, { createdAt: daysAgo(200), trainerIds: [gone.trainerId] });
      const trainingId = await createTrainingFor(gone.trainerId, student.userId);
      await createSession(trainingId, student.userId, { finishedAt: daysAgo(3) });
      await prisma.trainer.update({ where: { id: gone.trainerId }, data: { deletedAt: daysAgo(1) } });

      const body = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_30);

      expect(body.kpis.activeTrainers.current).toBe(0);
    });
  });

  describe('weekly signups (AC 5)', () => {
    it('should bucket trainers and students into the 8 Sao Paulo weeks', async () => {
      const oldTrainer = await createPlacedTrainer(app, { createdAt: daysAgo(100) });
      await createPlacedTrainer(app, { createdAt: new Date() });
      await createPlacedTrainer(app, { createdAt: daysAgo(21), trainerDeleted: true });
      await createPlacedStudent(app, { createdAt: daysAgo(21), trainerIds: [oldTrainer.trainerId] });
      await createPlacedStudent(app, { createdAt: daysAgo(21) });
      await createPlacedStudent(app, { createdAt: daysAgo(70), trainerIds: [oldTrainer.trainerId] });

      const body = await fetchOverview(app, admin.accessToken);

      const expected = expectedWeekStarts().map((weekStart) => ({ weekStart, trainers: 0, students: 0 }));
      expected[WEEK_COUNT - 1].trainers = 1;
      expected[WEEK_COUNT - 4].students = 1;
      expect(body.weeklySignups).toEqual(expected);
    });
  });

  describe('iArnold usage this month (AC 6)', () => {
    let heavy;
    let light;
    let knownRows;

    beforeEach(async () => {
      heavy = await createPlacedTrainer(app, { createdAt: daysAgo(200), firstName: 'Ana', lastName: 'Lima' });
      light = await createPlacedTrainer(app, { createdAt: daysAgo(200), firstName: 'Bruno', lastName: 'Reis' });
      await provisionTrainerPlan(heavy.trainerId, DIAMOND);
      knownRows = [
        tokenRow(AI_MODELS.ANTHROPIC, { inputTokens: 2_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 }),
        tokenRow(AI_MODELS.ANTHROPIC, { inputTokens: 1_000_000 }),
      ];
      for (const row of knownRows) await seedUsage(heavy.trainerId, row);
      await seedUsage(heavy.trainerId, { inputTokens: 50_000_000, billingMonth: PAST_BILLING_MONTH });
      await seedUsage(light.trainerId, { model: UNKNOWN_MODEL, inputTokens: 300_000, outputTokens: 10_000 });
    });

    it('should sum the current month counters, rows and distinct trainers', async () => {
      const { ai } = await fetchOverview(app, admin.accessToken);

      expect(ai).toMatchObject({
        month: getBillingMonth(),
        inputTokens: 3_300_000,
        outputTokens: 510_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 200_000,
        totalTokens: 5_010_000,
        interactions: 3,
        trainers: 2,
      });
    });

    it('should price known models only and flag the cost as partial', async () => {
      const { ai } = await fetchOverview(app, admin.accessToken);

      expect(ai.estimatedCostUsd).toBeGreaterThan(0);
      expect(ai.estimatedCostUsd).toBe(expectedCostUsd(knownRows));
      expect(ai.costComplete).toBe(false);
    });

    it('should rank top trainers by total tokens with their tier and cost', async () => {
      const { ai } = await fetchOverview(app, admin.accessToken);

      expect(ai.topTrainers).toEqual([
        {
          trainerId: heavy.trainerId,
          firstName: 'Ana',
          lastName: 'Lima',
          email: heavy.email,
          tier: DIAMOND,
          totalTokens: 4_700_000,
          estimatedCostUsd: expectedCostUsd(knownRows),
        },
        {
          trainerId: light.trainerId,
          firstName: 'Bruno',
          lastName: 'Reis',
          email: light.email,
          tier: FREE,
          totalTokens: 310_000,
          estimatedCostUsd: 0,
        },
      ]);
    });

    it('should not change with the selected period', async () => {
      const shortPeriod = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_7);
      const longPeriod = await fetchOverview(app, admin.accessToken, OVERVIEW_PERIODS.DAYS_90);

      expect(shortPeriod.ai).toEqual(longPeriod.ai);
    });
  });

  describe('iArnold cost completeness (AC 6)', () => {
    it('should flag the cost as complete when every model has a price', async () => {
      const trainer = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      await seedUsage(trainer.trainerId, { inputTokens: 1_000_000 });

      const { ai } = await fetchOverview(app, admin.accessToken);

      expect(ai.costComplete).toBe(true);
    });

    it('should keep only the 5 heaviest trainers in topTrainers', async () => {
      const trainers = [];
      for (let index = 0; index < TOP_LIMIT + 1; index += 1) {
        const trainer = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
        await seedUsage(trainer.trainerId, { inputTokens: 1_000 * (index + 1) });
        trainers.push(trainer.trainerId);
      }

      const { ai } = await fetchOverview(app, admin.accessToken);

      expect(ai.topTrainers.map((row) => row.trainerId)).toEqual(trainers.slice(1).reverse());
    });
  });

  describe('plans (AC 7)', () => {
    it('should count live trainers per tier in enum order, missing subscription as FREE', async () => {
      await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const pro = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const otherPro = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const beta = await createPlacedTrainer(app, { createdAt: daysAgo(200) });
      const deletedTrainer = await createPlacedTrainer(app, { createdAt: daysAgo(200), trainerDeleted: true });
      const deletedUser = await createPlacedTrainer(app, { createdAt: daysAgo(200), userDeleted: true });
      await provisionTrainerPlan(pro.trainerId, PRO);
      await provisionTrainerPlan(otherPro.trainerId, PRO);
      await provisionTrainerPlan(beta.trainerId, BETA);
      await provisionTrainerPlan(deletedTrainer.trainerId, DIAMOND);
      await provisionTrainerPlan(deletedUser.trainerId, PLATINUM);

      const body = await fetchOverview(app, admin.accessToken);

      expect(body.plans).toEqual([
        { tier: FREE, count: 1 },
        { tier: PRO, count: 2 },
        { tier: PLATINUM, count: 0 },
        { tier: DIAMOND, count: 0 },
        { tier: BETA, count: 1 },
      ]);
    });
  });

  describe('pending items (AC 8 and AC 10)', () => {
    beforeEach(async () => {
      const linked = await createPlacedTrainer(app, { createdAt: daysAgo(30) });
      await createPlacedStudent(app, { createdAt: daysAgo(30), trainerIds: [linked.trainerId] });
      await createPlacedTrainer(app, { createdAt: daysAgo(15) });
      await createPlacedTrainer(app, { createdAt: daysAgo(10) });
      await createPlacedTrainer(app, { createdAt: daysAgo(30), trainerDeleted: true });
      await createPlacedTrainer(app, { createdAt: daysAgo(30), userDeleted: true });
      await createInvite(admin.userId, { status: InviteStatus.PENDING, expiresAt: daysAgo(-7) });
      await createInvite(admin.userId, { status: InviteStatus.PENDING, expiresAt: daysAgo(1) });
      await createInvite(admin.userId, { status: InviteStatus.ACCEPTED, expiresAt: daysAgo(-7) });
      await createFeedback(linked.trainerId, FEEDBACK_STATUSES.NEW);
      await createFeedback(linked.trainerId, FEEDBACK_STATUSES.NEW);
      await createFeedback(linked.trainerId, FEEDBACK_STATUSES.READ);
    });

    it('should count unexpired pending invites, NEW feedbacks and live trainers without students for over 14 days', async () => {
      const body = await fetchOverview(app, admin.accessToken);

      expect(body.pending).toEqual({ pendingInvites: 1, newFeedbacks: 2, trainersWithoutStudents: 1 });
    });

    it('should return the badge counts from GET /admin/manager/pending', async () => {
      const response = await authGet(app, PENDING_URL, admin.accessToken);

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toEqual({ pendingInvites: 1, newFeedbacks: 2 });
    });
  });

  describe('GET /admin/manager/pending access (AC 10)', () => {
    it('should answer zeros on an empty platform', async () => {
      const response = await authGet(app, PENDING_URL, admin.accessToken);

      expect(response.json()).toEqual({ pendingInvites: 0, newFeedbacks: 0 });
    });

    it('should answer 403 auth.forbidden to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await authGet(app, PENDING_URL, accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('should answer 401 without a token', async () => {
      const response = await authGet(app, PENDING_URL, null);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });
  });

  describe('latest trainers (AC 9)', () => {
    it('should list the 5 newest live trainers with tier and student count', async () => {
      const seeds = [];
      const tiedInstant = daysAgo(3);
      for (let index = 1; index <= 7; index += 1) {
        const createdAt = TIED_INDEXES.includes(index) ? tiedInstant : daysAgo(index);
        const trainer = await createPlacedTrainer(app, { createdAt, firstName: `Nome${index}`, lastName: `Sobrenome${index}` });
        seeds.push({ ...trainer, createdAt, firstName: `Nome${index}`, lastName: `Sobrenome${index}` });
      }
      await createPlacedTrainer(app, { createdAt: new Date(Date.now() - MS_PER_HOUR), trainerDeleted: true });
      await provisionTrainerPlan(seeds[0].trainerId, PRO);
      await createPlacedStudent(app, { createdAt: daysAgo(200), trainerIds: [seeds[0].trainerId] });
      await createPlacedStudent(app, { createdAt: daysAgo(200), trainerIds: [seeds[0].trainerId] });

      const body = await fetchOverview(app, admin.accessToken);

      const expected = [...seeds]
        .sort((left, right) => (right.createdAt - left.createdAt) || left.trainerId.localeCompare(right.trainerId))
        .slice(0, TOP_LIMIT)
        .map((seed) => ({
          userId: seed.userId,
          firstName: seed.firstName,
          lastName: seed.lastName,
          email: seed.email,
          tier: seed.trainerId === seeds[0].trainerId ? PRO : FREE,
          studentCount: seed.trainerId === seeds[0].trainerId ? 2 : 0,
          createdAt: seed.createdAt.toISOString(),
        }));
      expect(body.latestTrainers).toEqual(expected);
    });
  });
});

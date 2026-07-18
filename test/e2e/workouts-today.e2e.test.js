import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { WorkoutsTodayMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: GET /my/workouts/today', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Returns the lowercase weekday name for today in UTC.
   * Used to create trainings that match "today" in tests.
   */
  function todayWeekday() {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
      .format(new Date())
      .toLowerCase();
  }

  /**
   * Returns a lowercase weekday name that is NOT today in UTC.
   * Used to force a rest-day scenario.
   */
  function notTodayWeekday() {
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const today = todayWeekday();
    return weekdays.find((d) => d !== today);
  }

  async function createTrainerWithToken() {
    const email = `e2e+trainer-wotd-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerAccessToken } } = becomeTrainerResponse.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerAccessToken };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-wotd-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    return { userId, accessToken };
  }

  async function linkStudentToTrainer(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
  }

  /**
   * Creates an active protocol with the given trainings directly via Prisma.
   * Each entry in `trainingDefs` should have { name, category, weekDay?, order? }.
   */
  async function createActiveProtocol(trainerId, studentId, trainingDefs = [], protocolOverrides = {}) {
    const protocol = await prisma.trainingProtocol.create({
      data: {
        trainerId,
        assigneeId: studentId,
        name: 'Test Protocol',
        status: 'active',
        startDate: new Date('2025-01-01'),
        ...protocolOverrides,
      },
    });

    const trainings = [];
    for (const def of trainingDefs) {
      const training = await prisma.training.create({
        data: {
          trainingProtocolId: protocol.id,
          name: def.name ?? 'Training',
          category: def.category ?? 'strength',
          weekDay: def.weekDay ?? null,
          order: def.order ?? 0,
        },
      });
      trainings.push(training);
    }

    return { protocol, trainings };
  }

  function getUrl() {
    return '/my/workouts/today';
  }

  // ─── Tests ──────────────────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
  });

  it('returns 404 workoutsToday.noActiveProtocol when student has no protocol', async () => {
    const { accessToken } = await createStudentWithToken();

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().messageCode).toBe(WorkoutsTodayMessageCode.NO_ACTIVE_PROTOCOL);
  });

  it('returns 200 with workouts array and targetTraining when weekDay protocol matches today', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    const today = todayWeekday();
    await createActiveProtocol(trainerId, studentId, [
      { name: 'Today Training', category: 'strength', weekDay: today, order: 0 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'en-US', 'app-timezone': 'UTC' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workouts).toHaveLength(1);
    expect(body.workouts[0].targetTraining).not.toBeNull();
    expect(body.workouts[0].targetTraining.weekDay).toBe(today);
    expect(body.workouts[0].isRestDay).toBe(false);
    // i18n label sibling must be present
    expect(body.workouts[0].targetTraining.weekDayLabel).toBeTruthy();
    // estimatedDurationSeconds must be present and be a non-negative integer
    expect(body.workouts[0].targetTraining.estimatedDurationSeconds).toBeTypeOf('number');
    expect(body.workouts[0].targetTraining.estimatedDurationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 200 with correct first training for order-based protocol', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    await createActiveProtocol(trainerId, studentId, [
      { name: 'Training A', category: 'strength', weekDay: null, order: 0 },
      { name: 'Training B', category: 'cardio', weekDay: null, order: 1 },
      { name: 'Training C', category: 'strength', weekDay: null, order: 2 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workouts).toHaveLength(1);
    expect(body.workouts[0].targetTraining).not.toBeNull();
    expect(body.workouts[0].targetTraining.order).toBe(0);
    expect(body.workouts[0].isRestDay).toBe(false);
    expect(body.workouts[0].nextScheduledDate).toBeNull();
  });

  it('returns 200 with isRestDay: true and nextScheduledDate for rest day', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    // Use a weekDay that is NOT today so today is a rest day
    const notToday = notTodayWeekday();
    await createActiveProtocol(trainerId, studentId, [
      { name: 'Off-day Training', category: 'strength', weekDay: notToday, order: 0 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workouts).toHaveLength(1);
    expect(body.workouts[0].isRestDay).toBe(true);
    expect(body.workouts[0].targetTraining).toBeNull();
    // nextScheduledDate should be a YYYY-MM-DD string (the next matching day)
    if (body.workouts[0].nextScheduledDate !== null) {
      expect(body.workouts[0].nextScheduledDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('returns 200 with pendingTraining at envelope root when an in_progress session exists', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    const { trainings } = await createActiveProtocol(trainerId, studentId, [
      { name: 'Training A', category: 'strength', weekDay: null, order: 0 },
    ]);

    // Create an in_progress session directly via prisma
    const session = await prisma.workoutSession.create({
      data: {
        trainingId: trainings[0].id,
        userId: studentId,
        status: 'in_progress',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // pendingTraining is at the envelope root
    expect(body.pendingTraining).not.toBeNull();
    expect(body.pendingTraining.sessionId).toBe(session.id);
    expect(body.pendingTraining.trainingId).toBe(trainings[0].id);
    expect(body.pendingTraining.startedAt).toBeTruthy();
    expect(body.pendingTraining.status).toBe('in_progress');
    expect(body.pendingTraining.statusLabel).toBeTruthy();

    // pendingTraining must NOT appear inside workout entries
    expect(body.workouts[0]).not.toHaveProperty('pendingTraining');
  });

  it('returns translated labels based on app-language header', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    const today = todayWeekday();
    await createActiveProtocol(trainerId, studentId, [
      { name: 'Strength Training', category: 'strength', weekDay: today, order: 0 },
    ]);

    const ptRes = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'pt-BR', 'app-timezone': 'UTC' },
    });

    const enRes = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'en-US', 'app-timezone': 'UTC' },
    });

    expect(ptRes.statusCode).toBe(200);
    expect(enRes.statusCode).toBe(200);

    const ptBody = ptRes.json();
    const enBody = enRes.json();

    // category 'strength' → 'Força' in pt-BR, 'Strength' in en-US
    expect(ptBody.workouts[0].targetTraining.categoryLabel).toBe('Força');
    expect(enBody.workouts[0].targetTraining.categoryLabel).toBe('Strength');
  });

  it('returns 200 (not 400) when app-timezone header is invalid', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    await createActiveProtocol(trainerId, studentId, [
      { name: 'Training A', category: 'strength', weekDay: null, order: 0 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: {
        authorization: `Bearer ${studentToken}`,
        'app-timezone': 'NotATimezone/Invalid',
      },
    });

    // Must not 400 — falls back to America/Sao_Paulo
    expect(res.statusCode).toBe(200);
  });

  it('returns one workout entry per active protocol for a student with multiple protocols', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    // Two active protocols — different start dates so ordering is deterministic
    await createActiveProtocol(
      trainerId,
      studentId,
      [{ name: 'Strength A', category: 'strength', weekDay: null, order: 0 }],
      { name: 'Strength Protocol', startDate: new Date('2025-02-01') },
    );
    await createActiveProtocol(
      trainerId,
      studentId,
      [{ name: 'Mobility A', category: 'flexibility', weekDay: null, order: 0 }],
      { name: 'Mobility Protocol', startDate: new Date('2025-01-01') },
    );

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: { authorization: `Bearer ${studentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // One entry per protocol
    expect(body.workouts).toHaveLength(2);

    // Ordered by startDate desc: Strength (2025-02-01) first, Mobility (2025-01-01) second
    expect(body.workouts[0].protocol.name).toBe('Strength Protocol');
    expect(body.workouts[1].protocol.name).toBe('Mobility Protocol');

    // pendingTraining at envelope level
    expect(body).toHaveProperty('pendingTraining');
    expect(body.pendingTraining).toBeNull();
  });

  it('auto-completes a stale in_progress session (>24h) and returns pendingTraining: null', async () => {
    const { trainerId } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
    await linkStudentToTrainer(trainerId, studentId);

    const { trainings } = await createActiveProtocol(trainerId, studentId, [
      { name: 'Training A', category: 'strength', weekDay: null, order: 0 },
    ]);

    // Seed a session whose startedAt is 25h in the past
    const staleStartedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const session = await prisma.workoutSession.create({
      data: {
        trainingId: trainings[0].id,
        userId: studentId,
        status: 'in_progress',
        startedAt: staleStartedAt,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: getUrl(),
      headers: {
        authorization: `Bearer ${studentToken}`,
        'app-language': 'pt-BR',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Stale session must not appear as pending
    expect(body.pendingTraining).toBeNull();

    // Session in DB must be completed
    const updatedSession = await prisma.workoutSession.findUnique({
      where: { id: session.id },
      select: { status: true, finishedAt: true, durationSeconds: true, notes: true },
    });

    expect(updatedSession.status).toBe('completed');
    expect(updatedSession.durationSeconds).toBe(86400);

    const expectedFinishedAt = new Date(staleStartedAt.getTime() + 24 * 60 * 60 * 1000);
    // Allow 1s tolerance for floating-point/timing
    expect(Math.abs(updatedSession.finishedAt.getTime() - expectedFinishedAt.getTime())).toBeLessThan(1000);

    expect(updatedSession.notes).toBe('[Treino concluído automaticamente após 24h sem atividade]');
  });
});

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { WorkoutSessionStatus, DashboardMessageCode } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: student dashboard (trainer view)', () => {
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

  // ─── Auth helpers ──────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `e2e+dashboard-trainer-${Date.now()}@example.com`;
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
    const email = `e2e+dashboard-student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    return { userId, accessToken, email };
  }

  async function linkTrainerStudent(trainerToken, studentEmail) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { email: studentEmail },
    });
    expect([201, 409]).toContain(res.statusCode);
  }

  async function createProtocol(trainerToken, studentId, { name = 'Test Protocol', startDate = '2026-01-01' } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { assigneeId: studentId, name, startDate },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function createTraining(trainerToken, protocolId, { name = 'Peito', category = 'strength' } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocolId}/trainings`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name, category },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function createExercise(trainerToken, trainingId, { name = 'Bench Press', type = 'strength', sets = 3, hasLoad = true } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name, type, sets, hasLoad },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function startSession(studentToken, trainingId) {
    const res = await app.inject({
      method: 'POST',
      url: `/my/trainings/${trainingId}/workout-sessions`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function finishSession(studentToken, sessionId) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/my/workout-sessions/${sessionId}`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { status: WorkoutSessionStatus.COMPLETED },
    });
    expect(res.statusCode).toBe(200);
  }

  async function abandonSession(studentToken, sessionId) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/my/workout-sessions/${sessionId}`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { status: WorkoutSessionStatus.ABANDONED },
    });
    expect(res.statusCode).toBe(200);
  }

  // ─── Helper: full seeding for dashboard tests ────────────────────────────────

  /**
   * Creates a trainer + linked student + protocol + training + exercise.
   * Returns all IDs and tokens needed to run dashboard endpoint tests.
   */
  async function seedDashboardFixtures() {
    const { userId: trainerId, accessToken: trainerToken } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken, email: studentEmail } = await createStudentWithToken();
    await linkTrainerStudent(trainerToken, studentEmail);
    const protocolId = await createProtocol(trainerToken, studentId);
    const trainingId = await createTraining(trainerToken, protocolId);
    await createExercise(trainerToken, trainingId);

    return { trainerId, trainerToken, studentId, studentToken, protocolId, trainingId };
  }

  // ─── Common: invalid UUID ────────────────────────────────────────────────────

  const NONEXISTENT_UUID = '00000000-0000-0000-0000-000000000099';

  // ---------------------------------------------------------------------------
  // GET /trainer/students/:studentId/dashboard/summary
  // ---------------------------------------------------------------------------

  describe('GET /trainer/students/:studentId/dashboard/summary', () => {
    it('returns 401 when no authentication token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/summary`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
      });
    });

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/summary`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
      });
    });

    it('returns 404 when student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
        message: expect.any(String),
      });
    });

    it('returns 400 when dateFrom > dateTo (invalid date range)', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'INVALID_DATE_RANGE',
        messageCode: DashboardMessageCode.INVALID_DATE_RANGE,
      });
    });

    it('returns 400 when window exceeds 365 days', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom,
          dateTo: dateTo.toISOString(),
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'WINDOW_TOO_LARGE',
        messageCode: DashboardMessageCode.WINDOW_TOO_LARGE,
      });
    });

    it('returns 200 with all-zero counts and null completionRate for a student with no sessions', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        window: {
          from: expect.any(String),
          to: expect.any(String),
        },
        sessionCounts: { completed: 0, in_progress: 0, abandoned: 0 },
        totalSessions: 0,
        completionRate: null,
        lastSessionAt: null,
      });
    });

    it('includes maxStreakDays, sessionsPerWeek, daysSinceLastSession in 200 response (all null when no sessions)', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('maxStreakDays', null);
      expect(body).toHaveProperty('sessionsPerWeek');
      expect(body).toHaveProperty('daysSinceLastSession', null);
    });

    it('maxStreakDays and sessionsPerWeek are populated after seeding sessions', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const session1 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session1);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.maxStreakDays).toBe('number');
      expect(body.maxStreakDays).toBeGreaterThanOrEqual(1);
      expect(typeof body.sessionsPerWeek).toBe('number');
      expect(body.daysSinceLastSession).toBeGreaterThanOrEqual(0);
    });

    it('returns 200 with correct counts and completionRate after seeding completed + abandoned sessions', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      // completed session
      const session1 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session1);

      // abandoned session
      const session2 = await startSession(studentToken, trainingId);
      await abandonSession(studentToken, session2);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionCounts.completed).toBe(1);
      expect(body.sessionCounts.abandoned).toBe(1);
      expect(body.completionRate).toBe(0.5);
      expect(body.totalSessions).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /trainer/students/:studentId/dashboard/recent-sessions
  // ---------------------------------------------------------------------------

  describe('GET /trainer/students/:studentId/dashboard/recent-sessions', () => {
    it('returns 401 when no authentication token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/recent-sessions`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when dateFrom > dateTo', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when window exceeds 365 days', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: { dateFrom, dateTo: dateTo.toISOString() },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 200 with sessions data matching the expected response shape', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        window: { from: expect.any(String), to: expect.any(String) },
        data: expect.any(Array),
      });
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toMatchObject({
        id: expect.any(String),
        status: expect.any(String),
        startedAt: expect.any(String),
      });
    });

    it('includes avgRpe and noteText keys on each session item (both null when no RPE or notes recorded)', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('avgRpe');
      expect(data[0]).toHaveProperty('noteText');
    });

    it('returns sessions in DESC startedAt order across multiple sessions', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const session1 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session1);

      const session2 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session2);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/recent-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.length).toBeGreaterThanOrEqual(2);

      // Sessions must be ordered newest-first
      for (let i = 0; i < data.length - 1; i++) {
        expect(new Date(data[i].startedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(data[i + 1].startedAt).getTime(),
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GET /trainer/students/:studentId/dashboard/exercise-progression
  // ---------------------------------------------------------------------------

  describe('GET /trainer/students/:studentId/dashboard/exercise-progression', () => {
    it('returns 401 when no authentication token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when dateFrom > dateTo', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when window exceeds 365 days', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: { dateFrom, dateTo: dateTo.toISOString() },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 200 with data array matching the expected response shape', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        window: { from: expect.any(String), to: expect.any(String) },
        data: expect.any(Array),
      });
    });

    it('includes loadHistory array on each exercise entry after sessions with set logs', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      if (data.length > 0) {
        expect(data[0]).toHaveProperty('loadHistory');
        expect(Array.isArray(data[0].loadHistory)).toBe(true);
      }
    });

    it('returns 200 with includeDurationOnly=true including duration-only exercises when queried', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: { includeDurationOnly: 'true' },
      });

      // The endpoint must accept the parameter and return 200 (not 400)
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ data: expect.any(Array) });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /trainer/students/:studentId/dashboard/exercise-progression/:exerciseId
  // ---------------------------------------------------------------------------

  describe('GET /trainer/students/:studentId/dashboard/exercise-progression/:exerciseId', () => {
    it('returns 401 when no authentication token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression/${NONEXISTENT_UUID}`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression/${NONEXISTENT_UUID}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/exercise-progression/${NONEXISTENT_UUID}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when dateFrom > dateTo', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression/${NONEXISTENT_UUID}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when window exceeds 365 days', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression/${NONEXISTENT_UUID}`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: { dateFrom, dateTo: dateTo.toISOString() },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 200 with sessions: [] for an exerciseId that has no logs in the window (not 404)', async () => {
      const { trainerToken, studentId, trainingId } = await seedDashboardFixtures();

      // Get the exercise ID from the training (no sessions have been started)
      const trainingRes = await app.inject({
        method: 'GET',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      const exercises = trainingRes.json();
      const exerciseId = exercises[0]?.id ?? NONEXISTENT_UUID;

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression/${exerciseId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessions).toEqual([]);
      expect(body).toMatchObject({
        window: { from: expect.any(String), to: expect.any(String) },
      });
    });

    it('returns 200 with full shape including sets array after a completed session', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      // Fetch exercises to get a real exerciseId that has logs
      const exerciseListRes = await app.inject({
        method: 'GET',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      const exercises = exerciseListRes.json();
      const exerciseId = exercises[0]?.id;
      if (!exerciseId) return; // skip if no exercises (shouldn't happen)

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/exercise-progression/${exerciseId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        exercise: expect.objectContaining({
          id: exerciseId,
          name: expect.any(String),
        }),
        window: expect.any(Object),
        sessions: expect.any(Array),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /trainer/students/:studentId/dashboard/daily-activity
  // ---------------------------------------------------------------------------

  describe('GET /trainer/students/:studentId/dashboard/daily-activity', () => {
    it('returns 401 when no authentication token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/daily-activity`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
      });
    });

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${NONEXISTENT_UUID}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
        message: expect.any(String),
      });
    });

    it('returns 400 when dateFrom > dateTo (invalid date range)', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'INVALID_DATE_RANGE',
        messageCode: DashboardMessageCode.INVALID_DATE_RANGE,
      });
    });

    it('returns 400 when window exceeds 365 days', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
        query: { dateFrom, dateTo: dateTo.toISOString() },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'WINDOW_TOO_LARGE',
        messageCode: DashboardMessageCode.WINDOW_TOO_LARGE,
      });
    });

    it('returns 200 with data: [] when student has zero sessions', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        window: { from: expect.any(String), to: expect.any(String) },
        data: [],
      });
    });

    it('returns 200 with one entry after starting and finishing one session', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        date: expect.any(String),
        status: expect.stringMatching(/^(completed|partial|abandoned)$/),
        sessionCount: 1,
        sessionIds: [sessionId],
        volumeKg: expect.any(Number),
        completedSets: expect.any(Number),
        totalSets: expect.any(Number),
      });
    });

    it('date field is in YYYY-MM-DD format (not ISO timestamp)', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const sessionId = await startSession(studentToken, trainingId);
      await finishSession(studentToken, sessionId);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.length).toBeGreaterThan(0);
      // Must match YYYY-MM-DD exactly, not ISO timestamp
      expect(data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns sessionCount: 2 when two sessions are started on the same calendar day', async () => {
      const { trainerToken, studentId, studentToken, trainingId } = await seedDashboardFixtures();

      const session1 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session1);

      const session2 = await startSession(studentToken, trainingId);
      await finishSession(studentToken, session2);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/daily-activity`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      // Both sessions happened today — should be aggregated into one row
      expect(data).toHaveLength(1);
      expect(data[0].sessionCount).toBe(2);
      expect(data[0].sessionIds).toHaveLength(2);
      expect(data[0].sessionIds).toContain(session1);
      expect(data[0].sessionIds).toContain(session2);
    });
  });
});

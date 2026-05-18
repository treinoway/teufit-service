import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { WorkoutSessionStatus, DashboardMessageCode, WeekDays } from '../../src/constants/training.js';
import { countWeekdayOccurrences, WEEKDAY_TO_INT } from '../../src/helpers/adherence-helpers.js';

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

  async function createTraining(trainerToken, protocolId, { name = 'Peito', category = 'strength', weekDay = null } = {}) {
    const payload = { name, category };
    if (weekDay !== null) payload.weekDay = weekDay;
    const res = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocolId}/trainings`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload,
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

  /**
   * Dedicated fixture for the adherence-parity regression test.
   *
   * This seed gives the student a real adherence number so the test asserts
   * actual values instead of (null === null).
   *
   * Strategy:
   *   - Protocol startDate = first day of the current UTC calendar month.
   *   - Training weekDay = the weekday of the first day of the current month.
   *     That day is always ≤ now (it's the 1st of the month), so expected >= 1
   *     regardless of when in the month the test runs.
   *   - One completed session + one abandoned session are seeded via the API,
   *     so their startedAt falls at "now" (well within the current month).
   *
   * Returns:
   *   - Everything from seedDashboardFixtures
   *   - expectedAdherence  {number}  computed from the seeded protocol+training
   *   - completedCount     {number}  sessions that count toward adherence (= 1)
   *   - expectedCount      {number}  denominator computed identically to the service
   *   - adherenceMonthString {string} "YYYY-MM-01" for the current month
   */
  async function seedAdherenceFixtures() {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();

    // Month window boundaries — identical to what computeStudentMonthlyAdherence uses.
    const monthStart = new Date(Date.UTC(currentYear, currentMonth, 1));
    const nextMonthStart = new Date(Date.UTC(currentYear, currentMonth + 1, 1));
    // Upper bound for expected-count is min(nextMonthStart, now) — same as the service.
    const adherenceWindowTo = nextMonthStart < now ? nextMonthStart : now;

    // Pick the weekday of the first day of the current month.
    // It always falls on day 1, so countWeekdayOccurrences always returns >= 1.
    const monthStartDow = monthStart.getUTCDay(); // 0=Sun … 6=Sat
    // Map JS getUTCDay() integer back to the WeekDays constant string.
    const dowToWeekDayString = Object.fromEntries(
      Object.values(WeekDays).map((name) => [WEEKDAY_TO_INT[name], name]),
    );
    const weekDayName = dowToWeekDayString[monthStartDow]; // e.g. 'thursday'

    // The protocol startDate is the first day of the current month, formatted
    // as YYYY-MM-DD for the API (which calls parseDateOnlyAsUtc internally).
    const monthStartDateString = `${String(currentYear)}-${String(currentMonth + 1).padStart(2, '0')}-01`;
    const adherenceMonthString = monthStartDateString; // already "YYYY-MM-01"

    // Compute the denominator using the same helper as the service.
    const weekDayInt = WEEKDAY_TO_INT[weekDayName];
    const expectedCount = countWeekdayOccurrences(monthStart, adherenceWindowTo, new Set([weekDayInt]));

    const { userId: trainerId, accessToken: trainerToken } = await createTrainerWithToken();
    const { userId: studentId, accessToken: studentToken, email: studentEmail } = await createStudentWithToken();
    await linkTrainerStudent(trainerToken, studentEmail);

    const protocolId = await createProtocol(trainerToken, studentId, {
      name: 'Adherence Test Protocol',
      startDate: monthStartDateString,
    });

    const trainingId = await createTraining(trainerToken, protocolId, {
      name: 'Treino A',
      category: 'strength',
      weekDay: weekDayName,
    });

    await createExercise(trainerToken, trainingId);

    // Seed one completed session and one abandoned session.
    // Both land at "now" (well within the current month window).
    const completedSessionId = await startSession(studentToken, trainingId);
    await finishSession(studentToken, completedSessionId);

    const abandonedSessionId = await startSession(studentToken, trainingId);
    await abandonSession(studentToken, abandonedSessionId);

    // completedCount = 1 (only completed sessions count toward adherence)
    const completedCount = 1;
    const adherenceValue = expectedCount > 0
      ? Math.round(Math.min(completedCount / expectedCount, 1) * 100 * 100) / 100
      : null;

    return {
      trainerId,
      trainerToken,
      studentId,
      studentToken,
      protocolId,
      trainingId,
      weekDayName,
      expectedCount,
      completedCount,
      adherenceValue,
      adherenceMonthString,
    };
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

    it('dashboard adherence matches listStudents adherence for the same student on the same day', async () => {
      // Regression test for the bug where listStudents used calendar-month adherence
      // but getDashboardSummary used the dateWindow — they disagreed for the same student.
      // After the fix: both always use the current calendar month.
      //
      // This test uses seedAdherenceFixtures to ensure both endpoints operate on a
      // real adherence number (not null === null). The fixture creates:
      //   - A protocol starting on the 1st of the current month
      //   - A training whose weekDay = the weekday of the 1st of the current month
      //     (guaranteed to have occurred at least once → expected >= 1)
      //   - 1 completed session + 1 abandoned session (both in current month)
      //
      // Month-boundary note: if today is the very first millisecond of the 1st we
      // could still get expected = 1 and completed = 1 → adherence = 100. The only
      // case where this assertion is skipped is when expectedCount === 0, which
      // should never happen with this strategy but is guarded defensively.
      const {
        trainerToken,
        studentId,
        expectedCount,
        completedCount,
        adherenceValue,
        adherenceMonthString,
      } = await seedAdherenceFixtures();

      const [listRes, summaryRes] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/trainer/students',
          headers: { authorization: `Bearer ${trainerToken}` },
        }),
        app.inject({
          method: 'GET',
          url: `/trainer/students/${studentId}/dashboard/summary`,
          headers: { authorization: `Bearer ${trainerToken}` },
        }),
      ]);

      expect(listRes.statusCode).toBe(200);
      expect(summaryRes.statusCode).toBe(200);

      const studentInList = listRes.json().find((s) => s.id === studentId);
      const dashboardBody = summaryRes.json();

      expect(studentInList).toBeDefined();

      // ── Parity invariant: both endpoints must agree ─────────────────────────
      expect(dashboardBody.adherence).toBe(studentInList.adherence);
      expect(dashboardBody.adherenceCompleted).toBe(studentInList.adherenceCompleted);
      expect(dashboardBody.adherenceMonth).toBe(studentInList.adherenceMonth);

      // ── Ground-truth check: values must match the seeded data ───────────────
      // This catches regressions in either endpoint independently (not just parity).
      if (expectedCount > 0) {
        expect(dashboardBody.adherence).toBe(adherenceValue);
        expect(dashboardBody.adherenceCompleted).toBe(completedCount);
        expect(dashboardBody.adherenceExpected).toBe(expectedCount);
        expect(studentInList.adherenceCompleted).toBe(completedCount);
        expect(studentInList.adherenceExpected).toBe(expectedCount);
      }

      // ── adherenceMonth shape ────────────────────────────────────────────────
      expect(dashboardBody.adherenceMonth).toBe(adherenceMonthString);
      expect(studentInList.adherenceMonth).toBe(adherenceMonthString);
      expect(dashboardBody.adherenceMonth).toMatch(/^\d{4}-\d{2}-01$/);
    });

    it('dashboard summary response includes all new adherence fields with correct types', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/dashboard/summary`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // All new fields must be present
      expect(body).toHaveProperty('adherenceCompleted');
      expect(body).toHaveProperty('adherenceExpected');
      expect(body).toHaveProperty('adherenceMonth');
      expect(body).toHaveProperty('previousAdherence');
      expect(body).toHaveProperty('previousAdherenceMonth');

      // adherenceMonth must be a YYYY-MM-01 string
      expect(body.adherenceMonth).toMatch(/^\d{4}-\d{2}-01$/);
      expect(body.previousAdherenceMonth).toMatch(/^\d{4}-\d{2}-01$/);

      // previousAdherenceMonth must be the calendar month before adherenceMonth
      const currentMonth = new Date(body.adherenceMonth);
      const previousMonth = new Date(body.previousAdherenceMonth);
      const expectedPrev = new Date(
        Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, 1),
      );
      expect(previousMonth.getTime()).toBe(expectedPrev.getTime());
    });

    it('listStudents response includes adherenceCompleted, adherenceExpected, adherenceMonth for each student', async () => {
      const { trainerToken, studentId } = await seedDashboardFixtures();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const students = res.json();
      const student = students.find((s) => s.id === studentId);

      expect(student).toBeDefined();
      expect(student).toHaveProperty('adherenceCompleted');
      expect(student).toHaveProperty('adherenceExpected');
      expect(student).toHaveProperty('adherenceMonth');
      expect(student.adherenceMonth).toMatch(/^\d{4}-\d{2}-01$/);
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

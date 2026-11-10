import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { weekStartFor } from '../../src/helpers/consistency-week.js';
import { SeasonStatus } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays, WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const BUSINESS_ZONE = 'America/Sao_Paulo';
const PASSWORD = 'StrongPassw0rd!';
const STANDINGS_URL = '/trainer/consistency-ranking/standings';
const CONFIG_URL = '/trainer/consistency-ranking/config';
const PAUSES_URL = '/trainer/consistency-ranking/pauses';
const CLOSE_URL = '/trainer/consistency-ranking/seasons/current/close';

let counter = 0;

// "YYYY-MM-DD" of a Date (UTC fields)
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Monday (midnight UTC, the @db.Date shape) of the running week in the business timezone
function currentMonday() {
  const { year, month, day } = weekStartFor(new Date(), BUSINESS_ZONE);
  return new Date(Date.UTC(year, month - 1, day));
}

// Monday shifted by whole weeks
function shiftWeeks(monday, weeks) {
  return new Date(monday.getTime() + weeks * WEEK_MS);
}

// Instant one minute after Monday 00:00 America/Sao_Paulo (UTC-3), inside the running week's counting window
function mondayMorning(monday) {
  return new Date(monday.getTime() + 3 * 3600000 + 60000);
}

e2eDescribe('e2e: consistency ranking trainer routes', () => {
  let app;
  const originalLaunchWeek = process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(() => {
    if (originalLaunchWeek === undefined) delete process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;
    else process.env.CONSISTENCY_RANKING_LAUNCH_WEEK = originalLaunchWeek;
  });

  async function signUp(prefix) {
    counter += 1;
    const email = `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
    const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  async function createTrainerWithToken() {
    const { userId, accessToken } = await signUp('ranking-trainer');
    const become = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId } });
    return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
  }

  function bearer(token) {
    return { authorization: `Bearer ${token}` };
  }

  async function createStudent(trainerId, firstName, monday = currentMonday()) {
    counter += 1;
    const user = await prisma.user.create({
      data: { email: `e2e+ranking-student-${Date.now()}-${counter}@example.com`, roles: [], firstName },
    });
    const twoWeeksAgo = shiftWeeks(monday, -2);
    await prisma.trainerStudent.create({ data: { trainerId, studentId: user.id, createdAt: twoWeeksAgo } });
    const lastWeek = shiftWeeks(monday, -1);
    const protocol = await prisma.trainingProtocol.create({
      data: {
        trainerId,
        assigneeId: user.id,
        name: 'Protocol',
        status: TrainingStatus.ACTIVE,
        startDate: twoWeeksAgo,
        createdAt: lastWeek,
        trainings: {
          create: [
            { name: 'A', category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY, createdAt: lastWeek },
            { name: 'B', category: TrainingCategory.FUNCTIONAL, weekDay: WeekDays.WEDNESDAY, createdAt: lastWeek },
            { name: 'C', category: TrainingCategory.CARDIO, weekDay: null, createdAt: lastWeek },
          ],
        },
      },
      include: { trainings: true },
    });
    const byCategory = Object.fromEntries(protocol.trainings.map((training) => [training.category, training]));
    return { id: user.id, trainings: byCategory };
  }

  function completeSession(student, category, finishedAt) {
    return prisma.workoutSession.create({
      data: {
        trainingId: student.trainings[category].id,
        userId: student.id,
        status: WorkoutSessionStatus.COMPLETED,
        finishedAt,
      },
    });
  }

  function createActiveSeason(trainerId, { number = 1, weeks = 4, startWeek = currentMonday() } = {}) {
    return prisma.consistencySeason.create({ data: { trainerId, number, startWeek, weeks } });
  }

  function getStandings(token, query = '') {
    return app.inject({ method: 'GET', url: `${STANDINGS_URL}${query}`, headers: bearer(token) });
  }

  describe('GET /trainer/consistency-ranking/standings', () => {
    it('RANK-27 reflects a completed session on the next read', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');

      const before = (await getStandings(token)).json();
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].partialScore).toBe(0);
      expect(before.rows[0].pillars).toEqual({
        workouts: { expected: 2, done: 0 },
        cardio: { expected: 1, done: 0 },
      });

      await completeSession(student, TrainingCategory.STRENGTH, mondayMorning(monday));

      const after = (await getStandings(token)).json();
      expect(after.rows[0].partialScore).toBe(33.3333);
      expect(after.rows[0].average).toBe(33.3333);
      expect(after.rows[0].pillars).toEqual({
        workouts: { expected: 2, done: 1 },
        cardio: { expected: 1, done: 0 },
      });
    });

    it("RANK-29 returns only the trainer's team", async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const other = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      await createActiveSeason(other.trainerId);
      const camila = await createStudent(trainerId, 'Camila');
      const bruno = await createStudent(trainerId, 'Bruno');
      const stranger = await createStudent(other.trainerId, 'Zeca');
      await completeSession(camila, TrainingCategory.STRENGTH, mondayMorning(monday));
      await completeSession(camila, TrainingCategory.FUNCTIONAL, mondayMorning(monday));
      await completeSession(stranger, TrainingCategory.STRENGTH, mondayMorning(monday));

      const res = await getStandings(token);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.season).toEqual({
        number: 1,
        startWeek: dateKey(monday),
        endWeek: dateKey(shiftWeeks(monday, 3)),
        weeks: 4,
        currentWeek: 1,
        status: 'active',
      });
      expect(body.entering).toEqual([]);
      expect(body.rows.map((row) => row.studentId)).toEqual([camila.id, bruno.id]);
      expect(body.rows.some((row) => row.studentId === stranger.id)).toBe(false);
      expect(body.rows[0]).toEqual({
        studentId: camila.id,
        name: 'Camila',
        position: 1,
        eligible: true,
        average: 66.6667,
        validWeeks: 1,
        weeksAt100: 0,
        streak: 0,
        partialScore: 66.6667,
        weekStatus: 'valid',
        pillars: { workouts: { expected: 2, done: 2 }, cardio: { expected: 1, done: 0 } },
      });
      expect(body.rows[1]).toEqual({
        studentId: bruno.id,
        name: 'Bruno',
        position: 2,
        eligible: true,
        average: 0,
        validWeeks: 1,
        weeksAt100: 0,
        streak: 0,
        partialScore: 0,
        weekStatus: 'valid',
        pillars: { workouts: { expected: 2, done: 0 }, cardio: { expected: 1, done: 0 } },
      });
      expect(typeof body.rows[0].average).toBe('number');
      expect(typeof body.rows[0].partialScore).toBe('number');
    });

    it('RANK-30 returns frozen standings for a closed season', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const closedStart = shiftWeeks(monday, -4);
      const closed = await createActiveSeason(trainerId, { number: 1, startWeek: closedStart });
      await prisma.consistencySeason.update({
        where: { id: closed.id },
        data: { status: SeasonStatus.CLOSED, closedAt: new Date(monday.getTime() - DAY_MS) },
      });
      await createActiveSeason(trainerId, { number: 2 });
      const camila = await createStudent(trainerId, 'Camila');
      const bruno = await createStudent(trainerId, 'Bruno');
      const frozenAt = new Date(monday.getTime() - DAY_MS);
      await prisma.consistencySeasonStanding.createMany({
        data: [
          { seasonId: closed.id, trainerId, studentId: camila.id, position: 1, eligible: true, average: '87.5000', validWeeks: 4, weeks100: 1, streak: 2, frozenAt },
          { seasonId: closed.id, trainerId, studentId: bruno.id, position: 2, eligible: true, average: '60.2500', validWeeks: 3, weeks100: 0, streak: 0, frozenAt },
        ],
      });

      const res = await getStandings(token, '?season=1');

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.season).toEqual({
        number: 1,
        startWeek: dateKey(closedStart),
        endWeek: dateKey(shiftWeeks(closedStart, 3)),
        weeks: 4,
        currentWeek: 4,
        status: 'closed',
      });
      expect(body.rows).toEqual([
        { studentId: camila.id, name: 'Camila', position: 1, eligible: true, average: 87.5, validWeeks: 4, weeksAt100: 1, streak: 2 },
        { studentId: bruno.id, name: 'Bruno', position: 2, eligible: true, average: 60.25, validWeeks: 3, weeksAt100: 0, streak: 0 },
      ]);

      const current = (await getStandings(token)).json();
      expect(current.season.number).toBe(2);
      expect(current.season.status).toBe('active');

      const unknown = await getStandings(token, '?season=9');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().messageCode).toBe('consistencyRanking.season.notFound');
    });

    it('RANK-31 rejects a user without trainer profile with 403', async () => {
      const { userId, trainerId, token } = await createTrainerWithToken();
      await prisma.trainer.delete({ where: { id: trainerId } });
      expect(userId).toBeTruthy();

      const res = await getStandings(token);

      expect(res.statusCode).toBe(403);
      expect(res.json().messageCode).toBe('trainer.notFound');
    });

    it('rejects a student with 403 and an unauthenticated call with 401', async () => {
      const student = await signUp('ranking-plain');

      const forbidden = await getStandings(student.accessToken);
      const anonymous = await app.inject({ method: 'GET', url: STANDINGS_URL });

      expect(forbidden.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });

    it('returns a null season and empty lists before the ranking launches', async () => {
      delete process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;
      const { trainerId, token } = await createTrainerWithToken();
      await createStudent(trainerId, 'Camila');

      const res = await getStandings(token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ season: null, rows: [], entering: [] });
    });

    it('creates the season once when concurrent reads race to open it', async () => {
      process.env.CONSISTENCY_RANKING_LAUNCH_WEEK = dateKey(shiftWeeks(currentMonday(), -1));
      const { trainerId, token } = await createTrainerWithToken();
      await createStudent(trainerId, 'Camila');

      const responses = await Promise.all(Array.from({ length: 5 }, () => getStandings(token)));

      expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(responses.map((res) => res.json().season.number))).toEqual(new Set([1]));
      const seasons = await prisma.consistencySeason.findMany({ where: { trainerId } });
      expect(seasons).toHaveLength(1);
      expect(seasons[0].number).toBe(1);
    });
  });

  describe('legacy ranking routes', () => {
    it('RANK-33 still answer 410', async () => {
      const { token } = await createTrainerWithToken();

      const trainerRanking = await app.inject({ method: 'GET', url: '/trainer/ranking', headers: bearer(token) });
      const myRanking = await app.inject({ method: 'GET', url: '/my/ranking', headers: bearer(token) });
      const myPoints = await app.inject({
        method: 'GET',
        url: '/my/points?challengeId=00000000-0000-4000-8000-000000000001',
        headers: bearer(token),
      });

      expect(trainerRanking.statusCode).toBe(410);
      expect(myRanking.statusCode).toBe(410);
      expect(trainerRanking.json().error).toBe('GLOBAL_RANKING_REMOVED');
      expect(myRanking.json().error).toBe('GLOBAL_RANKING_REMOVED');
      // why: /my/points is a live challenge-scoped route today (not 410); the test pins that it stays untouched
      expect(myPoints.statusCode).toBe(404);
      expect(myPoints.json().messageCode).toBe('student.notTrainee');
    });
  });

  describe('GET and PUT /trainer/consistency-ranking/config', () => {
    it('returns the defaults when never configured', async () => {
      const { token } = await createTrainerWithToken();

      const res = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
        activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
        seasonWeeks: 4,
        minPodiumWeeks: 2,
        closeWeekday: 0,
        closeHour: 21,
        timeZone: BUSINESS_ZONE,
      });
    });

    it('saves a valid update and reads it back', async () => {
      const { token } = await createTrainerWithToken();

      const put = await app.inject({
        method: 'PUT',
        url: CONFIG_URL,
        headers: bearer(token),
        payload: { seasonWeeks: 8, minPodiumWeeks: 3 },
      });

      expect(put.statusCode).toBe(200);
      expect(put.json().seasonWeeks).toBe(8);
      expect(put.json().minPodiumWeeks).toBe(3);
      expect(put.json().effectiveFrom).toBeNull();
      const get = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });
      expect(get.json().seasonWeeks).toBe(8);
      expect(get.json().minPodiumWeeks).toBe(3);
    });

    it('answers a weights update with the Monday it takes effect', async () => {
      const { token } = await createTrainerWithToken();

      const put = await app.inject({
        method: 'PUT',
        url: CONFIG_URL,
        headers: bearer(token),
        payload: { weights: { workouts: 40, diet: 20, cardio: 15, feedback: 15, hydration: 10 } },
      });

      expect(put.statusCode).toBe(200);
      expect(put.json().weights).toEqual({ workouts: 40, diet: 20, cardio: 15, feedback: 15, hydration: 10 });
      expect(put.json().effectiveFrom).toBe(dateKey(shiftWeeks(currentMonday(), 1)));
    });

    it('rejects weights that do not sum to 100 with 400', async () => {
      const { token } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'PUT',
        url: CONFIG_URL,
        headers: bearer(token),
        payload: { weights: { workouts: 50, diet: 30, cardio: 15, feedback: 15, hydration: 10 } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().messageCode).toBe('consistencyRanking.config.invalid');
      expect(res.json().details).toEqual({ weights: 'sumNot100' });
      const get = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });
      expect(get.json().weights).toEqual({ workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 });
    });

    it('rejects an invalid season length with 400', async () => {
      const { token } = await createTrainerWithToken();

      const res = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(token), payload: { seasonWeeks: 5 } });

      expect(res.statusCode).toBe(400);
    });

    it('rejects unauthenticated calls with 401', async () => {
      const get = await app.inject({ method: 'GET', url: CONFIG_URL });
      const put = await app.inject({ method: 'PUT', url: CONFIG_URL, payload: { closeHour: 20 } });

      expect(get.statusCode).toBe(401);
      expect(put.statusCode).toBe(401);
    });

    it('rejects a user without trainer profile with 403 trainer.notFound', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      await prisma.trainer.delete({ where: { id: trainerId } });

      const res = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(403);
      expect(res.json().messageCode).toBe('trainer.notFound');
    });
  });

  describe('POST and DELETE /trainer/consistency-ranking/pauses', () => {
    function sendPause(method, token, payload) {
      return app.inject({
        method,
        url: PAUSES_URL,
        headers: { ...bearer(token), 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    }

    it('pauses a future week for the team (POST 200) and resumes it (DELETE 200)', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const weekStart = dateKey(shiftWeeks(currentMonday(), 1));

      const pause = await sendPause('POST', token, { weekStart, reason: 'Feriado' });

      expect(pause.statusCode).toBe(200);
      expect(pause.json()).toEqual({ weekStart, studentId: null, paused: true, reason: 'Feriado' });
      expect(await prisma.consistencyWeekPause.count({ where: { trainerId, paused: true } })).toBe(1);

      const resume = await sendPause('DELETE', token, { weekStart });

      expect(resume.statusCode).toBe(200);
      expect(resume.headers['content-type']).toContain('application/json');
      expect(resume.json()).toEqual({ weekStart, studentId: null, paused: false });
      expect(await prisma.consistencyWeekPause.count({ where: { trainerId } })).toBe(0);
    });

    it('pauses one student of the trainer', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const student = await createStudent(trainerId, 'Camila');
      const weekStart = dateKey(shiftWeeks(currentMonday(), 2));

      const res = await sendPause('POST', token, { weekStart, studentId: student.id });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ weekStart, studentId: student.id, paused: true, reason: null });
    });

    it('accepts the farthest editable week, 12 weeks ahead', async () => {
      const { token } = await createTrainerWithToken();
      const weekStart = dateKey(shiftWeeks(currentMonday(), 12));

      const res = await sendPause('POST', token, { weekStart });

      expect(res.statusCode).toBe(200);
    });

    it('rejects a weekStart that is not a Monday with 400', async () => {
      const { token } = await createTrainerWithToken();
      const tuesday = dateKey(new Date(shiftWeeks(currentMonday(), 1).getTime() + DAY_MS));

      for (const method of ['POST', 'DELETE']) {
        const res = await sendPause(method, token, { weekStart: tuesday });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(body.messageCode).toBe('validation.failed');
        expect(body.details).toHaveLength(1);
        expect(body.details[0].field).toBe('weekStart');
      }
    });

    it('rejects an impossible calendar date with 400', async () => {
      const { token } = await createTrainerWithToken();

      for (const method of ['POST', 'DELETE']) {
        const res = await sendPause(method, token, { weekStart: '2030-02-30' });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('VALIDATION_ERROR');
        expect(res.json().messageCode).toBe('validation.failed');
        expect(res.json().details[0].field).toBe('weekStart');
      }
    });

    it('answers 404 student.notFound for a student of another trainer', async () => {
      const { token } = await createTrainerWithToken();
      const other = await createTrainerWithToken();
      const stranger = await createStudent(other.trainerId, 'Zeca');
      const weekStart = dateKey(shiftWeeks(currentMonday(), 1));

      const res = await sendPause('POST', token, { weekStart, studentId: stranger.id });

      expect(res.statusCode).toBe(404);
      expect(res.json().messageCode).toBe('student.notFound');
    });

    it('answers 409 for an already closed week', async () => {
      const { token } = await createTrainerWithToken();
      const weekStart = dateKey(shiftWeeks(currentMonday(), -1));

      const res = await sendPause('POST', token, { weekStart });

      expect(res.statusCode).toBe(409);
      expect(res.json().messageCode).toBe('consistencyRanking.pause.weekNotEditable');
      expect(res.json().details).toEqual({ weekStart });
    });

    it('answers 409 for a week 13 weeks ahead', async () => {
      const { token } = await createTrainerWithToken();
      const weekStart = dateKey(shiftWeeks(currentMonday(), 13));

      for (const method of ['POST', 'DELETE']) {
        const res = await sendPause(method, token, { weekStart });

        expect(res.statusCode).toBe(409);
        expect(res.json().messageCode).toBe('consistencyRanking.pause.weekNotEditable');
      }
    });

    it('rejects unauthenticated calls with 401', async () => {
      const res = await app.inject({ method: 'POST', url: PAUSES_URL, payload: { weekStart: '2030-01-07' } });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /trainer/consistency-ranking/seasons/current/close', () => {
    it('marks the active season to end at the next weekly close (200)', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);

      const res = await app.inject({ method: 'POST', url: CLOSE_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.number).toBe(1);
      expect(body.startWeek).toBe(dateKey(monday));
      expect(body.weeks).toBe(4);
      expect(body.status).toBe('active');
      expect(body.closeRequestedAt).toEqual(expect.any(String));
      const stored = await prisma.consistencySeason.findFirst({ where: { trainerId } });
      expect(stored.closeRequestedAt).not.toBeNull();
      expect(stored.status).toBe('active');
    });

    it('answers 404 without an active season', async () => {
      const { token } = await createTrainerWithToken();

      const res = await app.inject({ method: 'POST', url: CLOSE_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(404);
      expect(res.json().messageCode).toBe('consistencyRanking.season.notFound');
    });

    it('rejects a user without trainer profile with 403 trainer.notFound', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      await prisma.trainer.delete({ where: { id: trainerId } });

      const res = await app.inject({ method: 'POST', url: CLOSE_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(403);
      expect(res.json().messageCode).toBe('trainer.notFound');
    });
  });
});

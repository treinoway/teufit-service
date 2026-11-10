import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { createAdminWithToken } from '../helpers/admin-users.js';
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
const ADMIN_STANDINGS_PREFIX = '/admin/consistency-ranking/trainers';
// Fields the F2 panel adds to a student row of the trainer standings (Camila: no closed week, no signal, no pause)
const PANEL_FIELDS_OF_A_FRESH_STUDENT = {
  displayName: 'Camila',
  initials: 'C',
  faixa: 'restarting',
  weeks100: 0,
  seasonPillars: [],
  risk: null,
  signals: [],
  pause: null,
  entering: null,
};

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
        closesAt: expect.any(String),
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
        ...PANEL_FIELDS_OF_A_FRESH_STUDENT,
        currentWeekScore: 66.6667,
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
        ...PANEL_FIELDS_OF_A_FRESH_STUDENT,
        currentWeekScore: 0,
        displayName: 'Bruno',
        initials: 'B',
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
        closesAt: null,
      });
      expect(body.rows).toEqual([
        {
          ...PANEL_FIELDS_OF_A_FRESH_STUDENT,
          studentId: camila.id,
          name: 'Camila',
          position: 1,
          eligible: true,
          faixa: 'constant',
          average: 87.5,
          currentWeekScore: null,
          validWeeks: 4,
          weeks100: 1,
          weeksAt100: 1,
          streak: 2,
        },
        {
          ...PANEL_FIELDS_OF_A_FRESH_STUDENT,
          studentId: bruno.id,
          name: 'Bruno',
          displayName: 'Bruno',
          initials: 'B',
          position: 2,
          eligible: true,
          faixa: 'restarting',
          average: 60.25,
          currentWeekScore: null,
          validWeeks: 3,
          weeks100: 0,
          weeksAt100: 0,
          streak: 0,
        },
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
      const student = await signUp('ranking-no-profile');

      const res = await getStandings(token);
      const plainStudent = await getStandings(student.accessToken);

      expect(res.statusCode).toBe(403);
      expect(res.json().messageCode).toBe('trainer.notFound');
      expect(plainStudent.statusCode).toBe(403);
      expect(plainStudent.json().messageCode).toBe('trainer.notFound');
    });

    it('rejects a student with 403 trainer.notFound and an unauthenticated call with 401', async () => {
      const student = await signUp('ranking-plain');

      const forbidden = await getStandings(student.accessToken);
      const anonymous = await app.inject({ method: 'GET', url: STANDINGS_URL });

      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().messageCode).toBe('trainer.notFound');
      expect(anonymous.statusCode).toBe(401);
    });

    it('returns a null season and empty lists before the ranking launches', async () => {
      delete process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;
      const { trainerId, token } = await createTrainerWithToken();
      await createStudent(trainerId, 'Camila');

      const res = await getStandings(token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        season: null,
        summary: { teamAverage: null, lastClosedWeekAverage: null, fullLastWeek: 0, validLastWeek: 0, atRisk: 0, withSignal: 0 },
        counts: { all: 0, risk: 0, signal: 0, entering: 0, paused: 0 },
        rows: [],
        entering: [],
      });
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

  describe('GET /admin/consistency-ranking/trainers/:trainerId/standings', () => {
    function getAdminStandings(token, trainerId, query = '') {
      return app.inject({ method: 'GET', url: `${ADMIN_STANDINGS_PREFIX}/${trainerId}/standings${query}`, headers: bearer(token) });
    }

    it('RANK-28 returns the standings payload', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const camila = await createStudent(trainerId, 'Camila');
      const bruno = await createStudent(trainerId, 'Bruno');
      const diego = await createStudent(trainerId, 'Diego');
      await completeSession(diego, TrainingCategory.STRENGTH, mondayMorning(monday));
      await completeSession(diego, TrainingCategory.FUNCTIONAL, mondayMorning(monday));
      await completeSession(diego, TrainingCategory.CARDIO, mondayMorning(monday));
      await completeSession(camila, TrainingCategory.STRENGTH, mondayMorning(monday));
      await completeSession(camila, TrainingCategory.FUNCTIONAL, mondayMorning(monday));
      await completeSession(bruno, TrainingCategory.CARDIO, mondayMorning(monday));

      const res = await getAdminStandings(adminToken, trainerId);

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
      expect(body.rows).toEqual([
        {
          studentId: diego.id,
          name: 'Diego',
          position: 1,
          eligible: true,
          average: 100,
          validWeeks: 1,
          weeksAt100: 0,
          streak: 0,
          partialScore: 100,
          weekStatus: 'valid',
          pillars: { workouts: { expected: 2, done: 2 }, cardio: { expected: 1, done: 1 } },
        },
        {
          studentId: camila.id,
          name: 'Camila',
          position: 2,
          eligible: true,
          average: 66.6667,
          validWeeks: 1,
          weeksAt100: 0,
          streak: 0,
          partialScore: 66.6667,
          weekStatus: 'valid',
          pillars: { workouts: { expected: 2, done: 2 }, cardio: { expected: 1, done: 0 } },
        },
        {
          studentId: bruno.id,
          name: 'Bruno',
          position: 3,
          eligible: true,
          average: 33.3333,
          validWeeks: 1,
          weeksAt100: 0,
          streak: 0,
          partialScore: 33.3333,
          weekStatus: 'valid',
          pillars: { workouts: { expected: 2, done: 0 }, cardio: { expected: 1, done: 1 } },
        },
      ]);
      expect(typeof body.rows[0].average).toBe('number');
      expect(typeof body.rows[0].partialScore).toBe('number');
    });

    it('RANK-28 serves any trainer team, not the admin own', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const first = await createTrainerWithToken();
      const second = await createTrainerWithToken();
      await createActiveSeason(first.trainerId);
      await createActiveSeason(second.trainerId);
      const ana = await createStudent(first.trainerId, 'Ana');
      const zeca = await createStudent(second.trainerId, 'Zeca');

      const firstBody = (await getAdminStandings(adminToken, first.trainerId)).json();
      const secondBody = (await getAdminStandings(adminToken, second.trainerId)).json();

      expect(firstBody.rows.map((row) => row.studentId)).toEqual([ana.id]);
      expect(secondBody.rows.map((row) => row.studentId)).toEqual([zeca.id]);
    });

    it('returns frozen values for a closed season through season=', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken();
      const monday = currentMonday();
      const closedStart = shiftWeeks(monday, -4);
      const closed = await createActiveSeason(trainerId, { number: 1, startWeek: closedStart });
      await prisma.consistencySeason.update({
        where: { id: closed.id },
        data: { status: SeasonStatus.CLOSED, closedAt: new Date(monday.getTime() - DAY_MS) },
      });
      await createActiveSeason(trainerId, { number: 2 });
      const camila = await createStudent(trainerId, 'Camila');
      await prisma.consistencySeasonStanding.create({
        data: {
          seasonId: closed.id,
          trainerId,
          studentId: camila.id,
          position: 1,
          eligible: true,
          average: '87.5000',
          validWeeks: 4,
          weeks100: 1,
          streak: 2,
          frozenAt: new Date(monday.getTime() - DAY_MS),
        },
      });

      const res = await getAdminStandings(adminToken, trainerId, '?season=1');

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
      ]);
    });

    it('RANK-32 rejects a non-admin with 403', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const student = await signUp('ranking-plain-admin');

      const asTrainer = await getAdminStandings(token, trainerId);
      const asStudent = await getAdminStandings(student.accessToken, trainerId);

      expect(asTrainer.statusCode).toBe(403);
      expect(asStudent.statusCode).toBe(403);
    });

    it('answers 401 to an anonymous call', async () => {
      const { trainerId } = await createTrainerWithToken();

      const res = await app.inject({ method: 'GET', url: `${ADMIN_STANDINGS_PREFIX}/${trainerId}/standings` });

      expect(res.statusCode).toBe(401);
    });

    it('answers 404 for an unknown trainerId', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);

      const res = await getAdminStandings(adminToken, '00000000-0000-4000-8000-000000000099');

      expect(res.statusCode).toBe(404);
      expect(res.json().messageCode).toBe('resource.notFound');
    });

    it('answers 400 for a non-uuid trainerId', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);

      const res = await getAdminStandings(adminToken, 'not-a-uuid');

      expect(res.statusCode).toBe(400);
      expect(res.json().messageCode).toBe('validation.failed');
    });
  });

  describe('legacy ranking routes', () => {
    it('RANK-33 still answer 410', async () => {
      const { token } = await createTrainerWithToken();

      const trainerRanking = await app.inject({ method: 'GET', url: '/trainer/ranking', headers: bearer(token) });
      const myRanking = await app.inject({ method: 'GET', url: '/my/ranking', headers: bearer(token) });

      expect(trainerRanking.statusCode).toBe(410);
      expect(myRanking.statusCode).toBe(410);
      expect(trainerRanking.json().error).toBe('GLOBAL_RANKING_REMOVED');
      expect(myRanking.json().error).toBe('GLOBAL_RANKING_REMOVED');
    });

    it('RANK-56 keeps /my/points live', async () => {
      const { token } = await createTrainerWithToken();

      const myPoints = await app.inject({
        method: 'GET',
        url: '/my/points?challengeId=00000000-0000-4000-8000-000000000001',
        headers: bearer(token),
      });

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
        riskLimit: 70,
        riskWeeks: 2,
        minWorkoutMinutes: 10,
        batchCount: 5,
        batchMinutes: 30,
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

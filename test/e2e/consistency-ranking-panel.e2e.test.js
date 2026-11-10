import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { weekBounds, weekStartFor } from '../../src/helpers/consistency-week.js';
import { adjustTarget } from '../../src/services/consistency-target-service.js';
import { getPanelStandings } from '../../src/services/consistency-standings-service.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, DEFAULT_CONFIG, Pillar, SeasonStatus } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays, WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 3600000;
const BUSINESS_ZONE = 'America/Sao_Paulo';
const SAO_PAULO_OFFSET_HOURS = 3;
const PASSWORD = 'StrongPassw0rd!';
const QUICK_SECONDS = 240;
const BASE_URL = '/trainer/consistency-ranking';
const STANDINGS_URL = `${BASE_URL}/standings`;
const STUDENTS_URL = `${BASE_URL}/students`;
const HISTORY_URL = `${BASE_URL}/history`;
const SEASONS_URL = `${BASE_URL}/seasons`;
const CONFIG_URL = `${BASE_URL}/config`;
const PAUSES_URL = `${BASE_URL}/pauses`;

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
  return new Date(monday.getTime() + SAO_PAULO_OFFSET_HOURS * HOUR_MS + 60000);
}

// An instant on Monday morning, after the sessions the tests create and long before the weekly close
function mondayMidMorning(monday) {
  return new Date(monday.getTime() + (SAO_PAULO_OFFSET_HOURS + 2) * HOUR_MS);
}

// Close instant of the week starting on the Monday, with the default rule (Sunday 21:00 in Sao Paulo)
function closeInstantOf(monday) {
  const civil = { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
  return weekBounds(civil, DEFAULT_CONFIG).closeInstant;
}

e2eDescribe('e2e: consistency ranking panel', () => {
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

  async function signUp(prefix) {
    counter += 1;
    const email = `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
    const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  async function createTrainerWithToken() {
    const { userId, accessToken } = await signUp('panel-trainer');
    const become = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId } });
    return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
  }

  async function createStudent(trainerId, firstName, monday = currentMonday()) {
    counter += 1;
    const user = await prisma.user.create({
      data: { email: `e2e+panel-student-${Date.now()}-${counter}@example.com`, roles: [], firstName },
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

  function completeSession(student, category, finishedAt, durationSeconds) {
    return prisma.workoutSession.create({
      data: {
        trainingId: student.trainings[category].id,
        userId: student.id,
        status: WorkoutSessionStatus.COMPLETED,
        finishedAt,
        durationSeconds,
      },
    });
  }

  function createActiveSeason(trainerId, { number = 1, weeks = 4, startWeek = currentMonday() } = {}) {
    return prisma.consistencySeason.create({ data: { trainerId, number, startWeek, weeks } });
  }

  function bearer(token) {
    return { authorization: `Bearer ${token}` };
  }

  function getStandings(token, query = '') {
    return app.inject({ method: 'GET', url: `${STANDINGS_URL}${query}`, headers: bearer(token) });
  }

  function createClosedResults(trainerId, studentId, seasonId, monday, scores) {
    return prisma.consistencyWeeklyResult.createMany({
      data: scores.map((score, index) => ({
        trainerId,
        studentId,
        seasonId,
        weekStart: shiftWeeks(monday, index - scores.length),
        status: 'valid',
        score,
        pillars: { workouts: { expected: 2, done: 1 }, cardio: { expected: 1, done: 0 } },
        weights: { weights: DEFAULT_CONFIG.weights, activePillars: DEFAULT_CONFIG.activePillars },
        closedAt: new Date(),
      })),
    });
  }

  function storedTarget(trainerId, studentId, pillar, monday = currentMonday()) {
    return prisma.consistencyWeeklyTarget.findFirst({ where: { trainerId, studentId, weekStart: monday, pillar } });
  }

  describe('PUT /trainer/consistency-ranking/students/:studentId/targets', () => {
    it('PAN-33 adjusts the current week target', async () => {
      const { trainerId } = await createTrainerWithToken();
      const monday = currentMonday();
      const now = mondayMidMorning(monday);
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');
      await completeSession(student, TrainingCategory.STRENGTH, mondayMorning(monday));
      const before = (await getPanelStandings(prisma, trainerId, { now })).rows[0];

      const adjusted = await adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 1 }, now);

      const stored = await storedTarget(trainerId, student.id, Pillar.WORKOUTS);
      expect(adjusted).toMatchObject({ pillar: Pillar.WORKOUTS, expected: 2, adjusted: 1 });
      expect(stored).toMatchObject({ expected: 2, adjusted: 1 });
      expect(stored.adjustedAt).toBeInstanceOf(Date);
      const after = (await getPanelStandings(prisma, trainerId, { now })).rows[0];
      expect(before.currentWeekScore).toBe(33.3333);
      expect(after.currentWeekScore).toBe(66.6667);
    });

    it('PAN-33 accepts zero and the frozen target as the limits of the range', async () => {
      const { trainerId } = await createTrainerWithToken();
      const now = mondayMidMorning(currentMonday());
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');

      await adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.CARDIO, value: 0 }, now);
      await adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 2 }, now);

      expect(await storedTarget(trainerId, student.id, Pillar.CARDIO)).toMatchObject({ expected: 1, adjusted: 0 });
      expect(await storedTarget(trainerId, student.id, Pillar.WORKOUTS)).toMatchObject({ expected: 2, adjusted: 2 });
    });

    it('PAN-33 leaves other pillars and other students untouched', async () => {
      const { trainerId } = await createTrainerWithToken();
      const now = mondayMidMorning(currentMonday());
      await createActiveSeason(trainerId);
      const camila = await createStudent(trainerId, 'Camila');
      const bruno = await createStudent(trainerId, 'Bruno');

      await adjustTarget(prisma, trainerId, camila.id, { pillar: Pillar.WORKOUTS, value: 1 }, now);

      const adjustedRows = await prisma.consistencyWeeklyTarget.findMany({ where: { trainerId, adjusted: { not: null } } });
      expect(adjustedRows.map((row) => [row.studentId, row.pillar])).toEqual([[camila.id, Pillar.WORKOUTS]]);
      expect(await prisma.consistencyWeeklyTarget.count({ where: { trainerId, studentId: bruno.id, adjusted: { not: null } } })).toBe(0);
    });

    it('PAN-34 rejects an invalid adjustment with 409', async () => {
      const { trainerId } = await createTrainerWithToken();
      const now = mondayMidMorning(currentMonday());
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');

      const expected = {
        httpStatus: 409,
        error: ConsistencyErrorCode.TARGET_NOT_EDITABLE,
        messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE,
      };
      await expect(adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 3 }, now)).rejects.toMatchObject(expected);
      await expect(adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: -1 }, now)).rejects.toMatchObject(expected);
      await expect(adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 1.5 }, now)).rejects.toMatchObject(expected);
      expect(await storedTarget(trainerId, student.id, Pillar.WORKOUTS)).toMatchObject({ expected: 2, adjusted: null });
    });

    it('PAN-34 rejects an adjustment after the week closes and keeps the target', async () => {
      const { trainerId } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');
      await adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 2 }, mondayMidMorning(monday));
      const afterClose = new Date(closeInstantOf(monday).getTime() + 60000);

      await expect(adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 1 }, afterClose)).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE,
      });
      expect(await storedTarget(trainerId, student.id, Pillar.WORKOUTS)).toMatchObject({ adjusted: 2 });
    });

    it('PAN-34 rejects an adjustment of a week that already has its close mark', async () => {
      const { trainerId } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');
      await prisma.consistencyWeekClose.create({ data: { trainerId, weekStart: monday, closedAt: new Date(), studentsCount: 1 } });

      await expect(
        adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.WORKOUTS, value: 1 }, mondayMidMorning(monday)),
      ).rejects.toMatchObject({ httpStatus: 409, messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE });
    });

    it('PAN-34 rejects a pillar that has no target', async () => {
      const { trainerId } = await createTrainerWithToken();
      const now = mondayMidMorning(currentMonday());
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');

      await expect(adjustTarget(prisma, trainerId, student.id, { pillar: Pillar.DIET, value: 0 }, now)).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE,
      });
    });

    it('PAN-51 answers 404 and writes nothing for a student of another trainer', async () => {
      const { trainerId } = await createTrainerWithToken();
      const other = await createTrainerWithToken();
      const now = mondayMidMorning(currentMonday());
      await createActiveSeason(trainerId);
      await createActiveSeason(other.trainerId);
      const stranger = await createStudent(other.trainerId, 'Zeca');

      await expect(adjustTarget(prisma, trainerId, stranger.id, { pillar: Pillar.WORKOUTS, value: 1 }, now)).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'student.notFound',
      });
      expect(await prisma.consistencyWeeklyTarget.count({ where: { adjusted: { not: null } } })).toBe(0);
    });
  });

  describe('GET /trainer/consistency-ranking/standings', () => {
    it('PAN-46 returns the panel fields', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');
      const quick = await completeSession(student, TrainingCategory.STRENGTH, mondayMorning(monday), QUICK_SECONDS);

      const res = await getStandings(token);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.season).toMatchObject({ number: 1, currentWeek: 1, status: 'active' });
      expect(new Date(body.season.closesAt).getTime()).toBe(closeInstantOf(monday).getTime());
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({
        studentId: student.id,
        name: 'Camila',
        displayName: 'Camila',
        initials: 'C',
        position: 1,
        eligible: true,
        faixa: 'restarting',
        average: 33.3333,
        currentWeekScore: 33.3333,
        partialScore: 33.3333,
        weeks100: 0,
        weeksAt100: 0,
        seasonPillars: [],
        risk: null,
        pause: null,
        entering: null,
      });
      expect(body.rows[0].signals).toEqual([
        { type: 'quick_completion', sessionId: quick.id, finishedAt: mondayMorning(monday).toISOString(), durationSeconds: QUICK_SECONDS },
      ]);
      expect(body.entering).toEqual([]);
    });

    it('PAN-47 returns the filter counts and the summary numbers', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const camila = await createStudent(trainerId, 'Camila');
      await createStudent(trainerId, 'Bruno');
      await completeSession(camila, TrainingCategory.STRENGTH, mondayMorning(monday), QUICK_SECONDS);

      const body = (await getStandings(token)).json();

      expect(body.counts).toEqual({ all: 2, risk: 0, signal: 1, entering: 0, paused: 0 });
      expect(body.summary).toEqual({
        teamAverage: 16.67,
        lastClosedWeekAverage: null,
        fullLastWeek: 0,
        validLastWeek: 0,
        atRisk: 0,
        withSignal: 1,
      });
    });

    it('PAN-46 filters by group, searches by name and rejects an unknown filter', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const camila = await createStudent(trainerId, 'Camila');
      const joao = await createStudent(trainerId, 'João');
      await completeSession(camila, TrainingCategory.STRENGTH, mondayMorning(monday), QUICK_SECONDS);

      const signal = (await getStandings(token, '?filter=signal')).json();
      const search = (await getStandings(token, `?q=${encodeURIComponent('JOAO')}`)).json();
      const invalid = await getStandings(token, '?filter=everyone');

      expect(signal.rows.map((row) => row.studentId)).toEqual([camila.id]);
      expect(search.rows.map((row) => row.studentId)).toEqual([joao.id]);
      expect(search.counts.all).toBe(2);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().messageCode).toBe('validation.failed');
    });

    it('PAN-46 returns risk with the weeks that caused it and orders the risk filter by average', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const rafael = await createStudent(trainerId, 'Rafael');
      const joao = await createStudent(trainerId, 'João');
      await createClosedResults(trainerId, rafael.id, season.id, monday, [66, 60]);
      await createClosedResults(trainerId, joao.id, season.id, monday, [64, 58]);

      const all = (await getStandings(token)).json();
      const atRisk = (await getStandings(token, '?filter=risk')).json();

      const joaoRow = all.rows.find((row) => row.studentId === joao.id);
      expect(joaoRow.risk).toEqual({ weeks: 2, scores: [64, 58] });
      expect(joaoRow.faixa).toBe('restarting');
      expect(joaoRow.seasonPillars).toEqual([
        { pillar: 'workouts', done: 2, expected: 4, adherence: 50 },
        { pillar: 'cardio', done: 0, expected: 2, adherence: 0 },
      ]);
      expect(all.counts.risk).toBe(2);
      expect(atRisk.rows.map((row) => row.studentId)).toEqual([joao.id, rafael.id]);
    });

    it('PAN-46 returns the pause of the running week with its reason', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const marcos = await createStudent(trainerId, 'Marcos');
      await createClosedResults(trainerId, marcos.id, season.id, monday, [100, 100]);
      const pause = await app.inject({
        method: 'POST',
        url: PAUSES_URL,
        headers: bearer(token),
        payload: { weekStart: dateKey(monday), studentId: marcos.id, reason: 'viagem' },
      });
      expect(pause.statusCode).toBe(200);

      const body = (await getStandings(token)).json();

      expect(body.rows[0].pause).toEqual({ weekStart: dateKey(monday), reason: 'viagem' });
      expect(body.rows[0].currentWeekScore).toBeNull();
      expect(body.counts.paused).toBe(1);
    });

    it('PAN-08 returns a closed paused week of the season with its reason and counts it as paused', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const marcos = await createStudent(trainerId, 'Marcos');
      await createClosedResults(trainerId, marcos.id, season.id, monday, [100]);
      const pausedWeek = shiftWeeks(monday, -2);
      await prisma.consistencyWeeklyResult.create({
        data: {
          trainerId,
          studentId: marcos.id,
          seasonId: season.id,
          weekStart: pausedWeek,
          status: 'paused',
          score: null,
          pillars: {},
          weights: { weights: DEFAULT_CONFIG.weights, activePillars: DEFAULT_CONFIG.activePillars },
          closedAt: new Date(),
        },
      });
      await prisma.consistencyWeekPause.create({ data: { trainerId, studentId: marcos.id, weekStart: pausedWeek, reason: 'viagem' } });

      const body = (await getStandings(token)).json();

      expect(body.rows[0].pause).toBeNull();
      expect(body.rows[0].closedPause).toEqual({ weekStart: dateKey(pausedWeek), reason: 'viagem' });
      expect(body.counts.paused).toBe(1);
    });

    it('PAN-17 gives the frozen standings of a closed season the pillars of its stored weeks', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const closedSeason = await prisma.consistencySeason.create({
        data: { trainerId, number: 1, startWeek: shiftWeeks(monday, -6), weeks: 4, status: 'closed', closedAt: new Date() },
      });
      await createActiveSeason(trainerId, { number: 2, startWeek: shiftWeeks(monday, -2) });
      const ana = await createStudent(trainerId, 'Ana');
      await createClosedResults(trainerId, ana.id, closedSeason.id, shiftWeeks(monday, -4), [100, 90]);
      await prisma.consistencySeasonStanding.create({
        data: { seasonId: closedSeason.id, trainerId, studentId: ana.id, position: 1, eligible: true, average: 95, validWeeks: 2, weeks100: 1, streak: 0, frozenAt: new Date() },
      });

      const body = (await getStandings(token, '?season=1')).json();

      expect(body.season).toMatchObject({ number: 1, status: 'closed' });
      expect(body.rows[0].seasonPillars).toEqual([
        { pillar: 'workouts', done: 2, expected: 4, adherence: 50 },
        { pillar: 'cardio', done: 0, expected: 2, adherence: 0 },
      ]);
    });

    it('PAN-46 lists a student still entering with progress and no position', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const ana = await createStudent(trainerId, 'Ana');
      const newbie = await createStudent(trainerId, 'Newbie');
      await createClosedResults(trainerId, ana.id, season.id, monday, [100, 100]);
      await prisma.trainerStudent.update({
        where: { trainerId_studentId: { trainerId, studentId: newbie.id } },
        data: { createdAt: shiftWeeks(monday, -1) },
      });
      await createClosedResults(trainerId, newbie.id, season.id, monday, [100]);
      await prisma.consistencyWeeklyTarget.create({ data: { trainerId, studentId: newbie.id, weekStart: monday, pillar: 'workouts', expected: 0 } });
      await prisma.consistencyWeeklyTarget.create({ data: { trainerId, studentId: newbie.id, weekStart: monday, pillar: 'cardio', expected: 0 } });

      const body = (await getStandings(token)).json();

      expect(body.rows.map((row) => row.studentId)).toEqual([ana.id]);
      expect(body.entering).toHaveLength(1);
      expect(body.entering[0]).toMatchObject({
        studentId: newbie.id,
        position: null,
        faixa: 'entering',
        entering: { validWeeks: 1, required: 2 },
        weeksMissing: 1,
      });
      expect(body.counts.entering).toBe(1);
    });

    it('PAN-46 returns a null season with empty lists before any season exists', async () => {
      const { token } = await createTrainerWithToken();

      const body = (await getStandings(token)).json();

      expect(body.season).toBeNull();
      expect(body.rows).toEqual([]);
      expect(body.counts).toEqual({ all: 0, risk: 0, signal: 0, entering: 0, paused: 0 });
    });
  });

  describe('GET /trainer/consistency-ranking/students/:studentId', () => {
    it('PAN-51 hides another trainer\'s student with 404', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const other = await createTrainerWithToken();
      await createActiveSeason(trainerId);
      await createActiveSeason(other.trainerId);
      const stranger = await createStudent(other.trainerId, 'Zeca');

      const read = await app.inject({ method: 'GET', url: `${STUDENTS_URL}/${stranger.id}`, headers: bearer(token) });
      const contact = await app.inject({
        method: 'POST',
        url: `${STUDENTS_URL}/${stranger.id}/contacts`,
        headers: bearer(token),
        payload: { pillar: 'cardio' },
      });
      const adjust = await app.inject({
        method: 'PUT',
        url: `${STUDENTS_URL}/${stranger.id}/targets`,
        headers: bearer(token),
        payload: { pillar: 'workouts', value: 1 },
      });

      for (const res of [read, contact, adjust]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ messageCode: 'student.notFound' });
      }
      expect(await prisma.consistencyContactLog.count()).toBe(0);
    });

    it('PAN-51 answers 401 without a token and 400 for a malformed student id', async () => {
      const { token } = await createTrainerWithToken();

      const anonymous = await app.inject({ method: 'GET', url: `${STUDENTS_URL}/${randomUUID()}` });
      const malformed = await app.inject({ method: 'GET', url: `${STUDENTS_URL}/not-a-uuid`, headers: bearer(token) });

      expect(anonymous.statusCode).toBe(401);
      expect(malformed.statusCode).toBe(400);
    });

    it('PAN-33 returns the frozen target of the running week per pillar and the adjusted value', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      await createActiveSeason(trainerId, { startWeek: currentMonday() });
      const joao = await createStudent(trainerId, 'João');
      const read = async () => (await app.inject({ method: 'GET', url: `${STUDENTS_URL}/${joao.id}`, headers: bearer(token) })).json();

      const before = await read();
      const adjust = await app.inject({ method: 'PUT', url: `${STUDENTS_URL}/${joao.id}/targets`, headers: bearer(token), payload: { pillar: 'workouts', value: 0 } });
      const after = await read();

      expect(adjust.statusCode).toBe(200);
      expect(before.currentTargets.map((target) => [target.pillar, target.adjusted])).toEqual([['workouts', null], ['cardio', null]]);
      expect(after.currentTargets.find((target) => target.pillar === 'workouts')).toMatchObject({ expected: before.currentTargets[0].expected, adjusted: 0 });
    });

    it('PAN-19 returns the student panel with risk, chart, pillars, weakest pillar and last contact', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const joao = await createStudent(trainerId, 'João');
      await createClosedResults(trainerId, joao.id, season.id, monday, [64, 58]);
      await prisma.socialNetwork.create({ data: { userId: joao.id, whatsapp: '+5511999990000' } });

      const before = (await app.inject({ method: 'GET', url: `${STUDENTS_URL}/${joao.id}`, headers: bearer(token) })).json();
      await app.inject({ method: 'POST', url: `${STUDENTS_URL}/${joao.id}/contacts`, headers: bearer(token), payload: { pillar: 'cardio' } });
      const after = (await app.inject({ method: 'GET', url: `${STUDENTS_URL}/${joao.id}`, headers: bearer(token) })).json();

      expect(before).toMatchObject({
        studentId: joao.id,
        firstName: 'João',
        whatsapp: '+5511999990000',
        position: 1,
        total: 1,
        faixa: 'restarting',
        risk: { weeks: 2, scores: [64, 58] },
        riskLimit: 70,
        weakestPillar: 'cardio',
        previousSeasons: [],
        lastContact: null,
      });
      expect(before.weeks.map((week) => [week.state, week.status, week.score])).toEqual([
        ['closed', 'valid', 64],
        ['closed', 'valid', 58],
        ['current', 'valid', 0],
        ['future', null, null],
      ]);
      expect(before.seasonPillars).toEqual([
        { pillar: 'workouts', done: 2, expected: 4, adherence: 50 },
        { pillar: 'cardio', done: 0, expected: 2, adherence: 0 },
      ]);
      expect(typeof after.lastContact).toBe('string');
    });
  });

  describe('POST /trainer/consistency-ranking/students/:studentId/contacts', () => {
    it('PAN-50 logs the contact', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');
      const url = `${STUDENTS_URL}/${student.id}/contacts`;

      const first = await app.inject({ method: 'POST', url, headers: bearer(token), payload: { pillar: 'cardio' } });
      const second = await app.inject({ method: 'POST', url, headers: bearer(token), payload: { pillar: 'cardio' } });

      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ studentId: student.id, pillar: 'cardio' });
      expect(second.statusCode).toBe(201);
      const logs = await prisma.consistencyContactLog.findMany({ where: { trainerId, studentId: student.id } });
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({ trainerId, studentId: student.id, pillar: 'cardio' });
      expect(logs[0].createdAt).toBeInstanceOf(Date);
    });

    it('PAN-50 logs a contact without a pillar and rejects an unknown pillar', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const student = await createStudent(trainerId, 'Camila');
      const url = `${STUDENTS_URL}/${student.id}/contacts`;

      const bare = await app.inject({ method: 'POST', url, headers: bearer(token), payload: {} });
      const invalid = await app.inject({ method: 'POST', url, headers: bearer(token), payload: { pillar: 'sleep' } });

      expect(bare.statusCode).toBe(201);
      expect(bare.json().pillar).toBeNull();
      expect(invalid.statusCode).toBe(400);
      expect(await prisma.consistencyContactLog.count({ where: { trainerId } })).toBe(1);
    });
  });

  describe('PUT /trainer/consistency-ranking/students/:studentId/targets (HTTP)', () => {
    it('PAN-33 route adjusts the target of the running week', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      await createActiveSeason(trainerId);
      const student = await createStudent(trainerId, 'Camila');

      const res = await app.inject({
        method: 'PUT',
        url: `${STUDENTS_URL}/${student.id}/targets`,
        headers: bearer(token),
        payload: { pillar: 'workouts', value: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ weekStart: dateKey(monday), pillar: 'workouts', expected: 2, adjusted: 1 });
      expect(await storedTarget(trainerId, student.id, 'workouts')).toMatchObject({ expected: 2, adjusted: 1 });
    });

    it('PAN-34 route answers 409 above the frozen target and 400 for a negative value or unknown pillar', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const student = await createStudent(trainerId, 'Camila');
      const url = `${STUDENTS_URL}/${student.id}/targets`;

      const above = await app.inject({ method: 'PUT', url, headers: bearer(token), payload: { pillar: 'workouts', value: 5 } });
      const negative = await app.inject({ method: 'PUT', url, headers: bearer(token), payload: { pillar: 'workouts', value: -1 } });
      const unknown = await app.inject({ method: 'PUT', url, headers: bearer(token), payload: { pillar: 'diet', value: 0 } });

      expect(above.statusCode).toBe(409);
      expect(above.json()).toMatchObject({
        error: ConsistencyErrorCode.TARGET_NOT_EDITABLE,
        messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE,
      });
      expect(negative.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(400);
      expect(await storedTarget(trainerId, student.id, 'workouts')).toMatchObject({ adjusted: null });
    });
  });

  describe('GET /trainer/consistency-ranking/history', () => {
    it('PAN-16 lists students with 4 or more valid weeks', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const season = await createActiveSeason(trainerId, { startWeek: shiftWeeks(monday, -2) });
      const veteran = await createStudent(trainerId, 'Ana', monday);
      const rookie = await createStudent(trainerId, 'Bia', monday);
      await createClosedResults(trainerId, veteran.id, season.id, shiftWeeks(monday, -2), [100, 100, 90, 100]);
      await createClosedResults(trainerId, rookie.id, season.id, shiftWeeks(monday, -2), [100, 100, 100]);

      const res = await app.inject({ method: 'GET', url: HISTORY_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(200);
      expect(res.json().rows).toEqual([
        { studentId: veteran.id, displayName: 'Ana', initials: 'A', validWeeks: 4, average: 97.5, weeks100: 3, longestStreak: 2 },
      ]);
    });

    it('PAN-16 answers 401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: HISTORY_URL });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/consistency-ranking/seasons', () => {
    it('PAN-17 lists closed seasons', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const ana = await createStudent(trainerId, 'Ana');
      const bia = await createStudent(trainerId, 'Bia');
      const closed = await prisma.consistencySeason.create({
        data: { trainerId, number: 1, startWeek: shiftWeeks(monday, -8), weeks: 4, status: SeasonStatus.CLOSED, closedAt: new Date() },
      });
      await createActiveSeason(trainerId, { number: 2 });
      await prisma.consistencySeasonStanding.createMany({
        data: [
          { seasonId: closed.id, trainerId, studentId: ana.id, position: 1, eligible: true, average: 90, validWeeks: 4, weeks100: 2, streak: 2, frozenAt: new Date() },
          { seasonId: closed.id, trainerId, studentId: bia.id, position: 2, eligible: true, average: 80, validWeeks: 4, weeks100: 1, streak: 1, frozenAt: new Date() },
        ],
      });

      const res = await app.inject({ method: 'GET', url: SEASONS_URL, headers: bearer(token) });

      expect(res.statusCode).toBe(200);
      expect(res.json().seasons).toEqual([
        { number: 1, startWeek: dateKey(shiftWeeks(monday, -8)), endWeek: dateKey(shiftWeeks(monday, -5)), weeks: 4, participants: 2, average: 85 },
      ]);
    });

    it('PAN-17 opens the frozen standings of a closed season with band and short name', async () => {
      const { trainerId, token } = await createTrainerWithToken();
      const monday = currentMonday();
      const ana = await createStudent(trainerId, 'Ana');
      const closed = await prisma.consistencySeason.create({
        data: { trainerId, number: 1, startWeek: shiftWeeks(monday, -8), weeks: 4, status: SeasonStatus.CLOSED, closedAt: new Date() },
      });
      await prisma.consistencySeasonStanding.create({
        data: { seasonId: closed.id, trainerId, studentId: ana.id, position: 1, eligible: true, average: 90, validWeeks: 4, weeks100: 2, streak: 2, frozenAt: new Date() },
      });

      const res = await getStandings(token, '?season=1');

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.season).toMatchObject({ number: 1, status: 'closed', closesAt: null });
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({ studentId: ana.id, name: 'Ana', displayName: 'Ana', position: 1, eligible: true, faixa: 'constant', average: 90, weeksAt100: 2, streak: 2 });
      expect(body.rows[0].partialScore).toBeUndefined();
    });
  });

  describe('GET and PUT /trainer/consistency-ranking/config (panel rules)', () => {
    it('PAN-41 saves the panel rules with immediate effect and returns them', async () => {
      const { token } = await createTrainerWithToken();
      const rules = { riskLimit: 60, riskWeeks: 3, minWorkoutMinutes: 15, batchCount: 8, batchMinutes: 45 };

      const before = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });
      const put = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(token), payload: rules });
      const after = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(token) });

      expect(before.json()).toMatchObject({ riskLimit: 70, riskWeeks: 2, minWorkoutMinutes: 10, batchCount: 5, batchMinutes: 30 });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ ...rules, effectiveFrom: null });
      expect(after.json()).toMatchObject(rules);
    });

    it('PAN-41 rejects a panel rule outside its range with 400', async () => {
      const { token } = await createTrainerWithToken();

      const res = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(token), payload: { riskLimit: 95 } });

      expect(res.statusCode).toBe(400);
    });
  });
});

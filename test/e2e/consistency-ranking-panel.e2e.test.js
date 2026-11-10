import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { weekBounds, weekStartFor } from '../../src/helpers/consistency-week.js';
import { adjustTarget } from '../../src/services/consistency-target-service.js';
import { getPanelStandings } from '../../src/services/consistency-standings-service.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, DEFAULT_CONFIG, Pillar } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays, WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 3600000;
const BUSINESS_ZONE = 'America/Sao_Paulo';
const SAO_PAULO_OFFSET_HOURS = 3;
const PASSWORD = 'StrongPassw0rd!';

let counter = 0;

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
});

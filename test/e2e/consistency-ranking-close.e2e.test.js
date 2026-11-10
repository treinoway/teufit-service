import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { closeDueWeeks, prepareCurrentWeek } from '../../src/services/consistency-close-service.js';
import { getStandings } from '../../src/services/consistency-standings-service.js';
import { requestEarlyClose } from '../../src/services/consistency-season-service.js';
import { updateConfig } from '../../src/services/consistency-config-service.js';
import { unlinkStudent } from '../../src/services/trainer-service.js';
import { Pillar, SeasonStatus, WeekStatus } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays, WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// Monday 2030-01-07; default rule is America/Sao_Paulo (UTC-3), so Monday 00:00 is 03:00Z
const WEEK_START = Object.freeze({ year: 2030, month: 1, day: 7 });
const WEEK_START_DATE = new Date(Date.UTC(2030, 0, 7));
const PROTOCOL_START = new Date(Date.UTC(2030, 0, 1));
const BEFORE_MONDAY = new Date('2030-01-06T15:00:00.000Z');
const AFTER_MONDAY = new Date('2030-01-08T15:00:00.000Z');
const CONCURRENT_RUNS = 4;

let counter = 0;

// Creates a user with a unique email
function createUser(prefix) {
  counter += 1;
  return prisma.user.create({ data: { email: `e2e+${prefix}-${Date.now()}-${counter}@example.com`, roles: [] } });
}

// Creates a trainer (and its user)
async function createTrainer() {
  const user = await createUser('target-trainer');
  return prisma.trainer.create({ data: { userId: user.id } });
}

// Creates a protocol for the student with the given trainings
function createProtocol({ trainerId, studentId, trainings, createdAt = BEFORE_MONDAY, ...overrides }) {
  return prisma.trainingProtocol.create({
    data: {
      trainerId,
      assigneeId: studentId,
      name: 'Protocol',
      status: TrainingStatus.ACTIVE,
      startDate: PROTOCOL_START,
      createdAt,
      trainings: {
        create: trainings.map((training) => ({ name: 'T', createdAt, ...training })),
      },
      ...overrides,
    },
  });
}

// Adds a training to an existing protocol
function addTraining(protocolId, training) {
  return prisma.training.create({ data: { trainingProtocolId: protocolId, name: 'Extra', ...training } });
}

// Stored targets of the student as { pillar: expected }
async function storedTargets(trainerId, studentId) {
  const rows = await prisma.consistencyWeeklyTarget.findMany({
    where: { trainerId, studentId, weekStart: WEEK_START_DATE },
  });
  return Object.fromEntries(rows.map((row) => [row.pillar, row.expected]));
}

const BASE_TRAININGS = [
  { category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY },
  { category: TrainingCategory.FUNCTIONAL, weekDay: WeekDays.WEDNESDAY },
  { category: TrainingCategory.CARDIO, weekDay: null },
  { category: TrainingCategory.REST, weekDay: WeekDays.SUNDAY },
];

const DONE_FROM = new Date('2030-01-07T03:00:00.000Z');
const DONE_TO = new Date('2030-01-14T03:00:00.000Z');
const INSIDE_WINDOW = new Date('2030-01-09T12:00:00.000Z');
const BEFORE_WINDOW = new Date('2030-01-07T02:59:59.000Z');
const AFTER_WINDOW = new Date('2030-01-14T03:00:01.000Z');

// Trainings of a protocol keyed by category
async function trainingByCategory(protocolId) {
  const rows = await prisma.training.findMany({ where: { trainingProtocolId: protocolId } });
  return Object.fromEntries(rows.map((row) => [row.category, row]));
}

// Creates a workout session of the student for a training
function createSession({ trainingId, studentId, finishedAt, status = WorkoutSessionStatus.COMPLETED, ...overrides }) {
  return prisma.workoutSession.create({ data: { trainingId, userId: studentId, status, finishedAt, ...overrides } });
}

// Creates a protocol with strength, cardio and rest trainings and returns them by category
async function createDoneSetup({ trainerId, studentId }) {
  const protocol = await createProtocol({
    trainerId,
    studentId,
    trainings: [
      { category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY },
      { category: TrainingCategory.CARDIO, weekDay: null },
      { category: TrainingCategory.REST, weekDay: WeekDays.SUNDAY },
    ],
  });
  return trainingByCategory(protocol.id);
}

// Logger double recording info and error calls
function createLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

// Trainer with an active season starting at WEEK_START
async function createTrainerWithSeason({ weeks = 2, ...overrides } = {}) {
  const trainer = await createTrainer();
  const season = await prisma.consistencySeason.create({
    data: { trainerId: trainer.id, number: 1, startWeek: WEEK_START_DATE, weeks, ...overrides },
  });
  return { trainer, season };
}

// Student linked to the trainer (2 workouts + 1 cardio target when it has the base protocol)
async function createLinkedStudent(trainerId, { createdAt = BEFORE_MONDAY, activeOnPlan = true, withProtocol = true, firstName } = {}) {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `e2e+close-student-${Date.now()}-${counter}@example.com`, roles: [], firstName },
  });
  await prisma.trainerStudent.create({ data: { trainerId, studentId: user.id, createdAt, activeOnPlan } });
  const protocol = withProtocol
    ? await createProtocol({ trainerId, studentId: user.id, trainings: BASE_TRAININGS })
    : null;
  const trainings = protocol ? await trainingByCategory(protocol.id) : null;
  return { id: user.id, trainings };
}

// Completed sessions of a student: strength and cardio counts finished at the instant
async function completeSessions(student, { strength = 0, cardio = 0, at }) {
  const make = (category) =>
    createSession({ trainingId: student.trainings[category].id, studentId: student.id, finishedAt: at });
  for (let i = 0; i < strength; i += 1) await make(TrainingCategory.STRENGTH);
  for (let i = 0; i < cardio; i += 1) await make(TrainingCategory.CARDIO);
}

// Stored results of the trainer ordered by week and student
function storedResults(trainerId) {
  return prisma.consistencyWeeklyResult.findMany({ where: { trainerId }, orderBy: [{ weekStart: 'asc' }, { studentId: 'asc' }] });
}

// Stored results keyed by student for one week
async function resultsByStudent(trainerId, weekStart = WEEK_START_DATE) {
  const rows = await prisma.consistencyWeeklyResult.findMany({ where: { trainerId, weekStart } });
  return Object.fromEntries(rows.map((row) => [row.studentId, row]));
}

// Prisma wrapper whose closed-week mark insert throws for one trainer, after that trainer's results were written
function prismaFailingMarkFor(failingTrainerId) {
  const bindIfFunction = (target, prop) => {
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrapTx = (tx) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop !== 'consistencyWeekClose') return bindIfFunction(target, prop);
        return new Proxy(target.consistencyWeekClose, {
          get(model, method) {
            if (method !== 'create') return bindIfFunction(model, method);
            return (args) => {
              if (args.data.trainerId === failingTrainerId) throw new Error('injected close failure');
              return model.create(args);
            };
          },
        });
      },
    });
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === '$transaction') return (fn, options) => target.$transaction((tx) => fn(wrapTx(tx)), options);
      return bindIfFunction(target, prop);
    },
  });
}

e2eDescribe('e2e: consistency ranking close', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('materializeTargets', () => {
    it('RANK-01 freezes the plan as of Monday 00:00', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      const protocol = await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });

      const first = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);
      expect(first.get(student.id)).toEqual({ workouts: 2, cardio: 1 });

      await addTraining(protocol.id, {
        category: TrainingCategory.STRENGTH,
        weekDay: WeekDays.FRIDAY,
        createdAt: AFTER_MONDAY,
      });
      const second = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(second.get(student.id)).toEqual({ workouts: 2, cardio: 1 });
      expect(await storedTargets(trainer.id, student.id)).toEqual({ [Pillar.WORKOUTS]: 2, [Pillar.CARDIO]: 1 });
    });

    it('does not count a training created after Monday 00:00 even on the first computation', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      const protocol = await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });
      await addTraining(protocol.id, {
        category: TrainingCategory.STRENGTH,
        weekDay: WeekDays.FRIDAY,
        createdAt: AFTER_MONDAY,
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 2, cardio: 1 });
    });

    it('does not overwrite an existing target', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });
      await prisma.consistencyWeeklyTarget.createMany({
        data: [
          { trainerId: trainer.id, studentId: student.id, weekStart: WEEK_START_DATE, pillar: Pillar.WORKOUTS, expected: 9 },
          { trainerId: trainer.id, studentId: student.id, weekStart: WEEK_START_DATE, pillar: Pillar.CARDIO, expected: 4 },
        ],
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 9, cardio: 4 });
      expect(await storedTargets(trainer.id, student.id)).toEqual({ [Pillar.WORKOUTS]: 9, [Pillar.CARDIO]: 4 });
    });

    it('counts a training created before Monday 00:00', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      const protocol = await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });
      await addTraining(protocol.id, {
        category: TrainingCategory.CARDIO,
        weekDay: WeekDays.SATURDAY,
        createdAt: BEFORE_MONDAY,
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 2, cardio: 2 });
    });

    it('ignores a training deleted before Monday and keeps one deleted after it', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      const protocol = await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });
      await addTraining(protocol.id, {
        category: TrainingCategory.STRENGTH,
        weekDay: WeekDays.THURSDAY,
        createdAt: new Date('2030-01-02T12:00:00.000Z'),
        deletedAt: BEFORE_MONDAY,
      });
      await addTraining(protocol.id, {
        category: TrainingCategory.STRENGTH,
        weekDay: WeekDays.FRIDAY,
        createdAt: new Date('2030-01-02T12:00:00.000Z'),
        deletedAt: AFTER_MONDAY,
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 3, cardio: 1 });
    });

    it('ignores a protocol created after Monday 00:00 and a soft-deleted or archived one', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      const training = [{ category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY }];
      await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: training, createdAt: AFTER_MONDAY });
      await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: training, deletedAt: BEFORE_MONDAY });
      await createProtocol({
        trainerId: trainer.id,
        studentId: student.id,
        trainings: training,
        status: TrainingStatus.ARCHIVED,
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 0, cardio: 0 });
    });

    it('ignores protocols of another trainer and protocols expired before the week', async () => {
      const trainer = await createTrainer();
      const otherTrainer = await createTrainer();
      const student = await createUser('target-student');
      const training = [{ category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY }];
      await createProtocol({ trainerId: otherTrainer.id, studentId: student.id, trainings: training });
      await createProtocol({
        trainerId: trainer.id,
        studentId: student.id,
        trainings: training,
        expirationDate: new Date(Date.UTC(2030, 0, 6)),
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(result.get(student.id)).toEqual({ workouts: 0, cardio: 0 });
    });

    it('stores explicit zero rows so computed-nothing differs from not-computed', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');

      await materializeTargets(prisma, trainer.id, WEEK_START, [student.id]);

      expect(await storedTargets(trainer.id, student.id)).toEqual({ [Pillar.WORKOUTS]: 0, [Pillar.CARDIO]: 0 });
    });

    it('materializes only the students missing a target and returns every student', async () => {
      const trainer = await createTrainer();
      const stored = await createUser('target-stored');
      const fresh = await createUser('target-fresh');
      await createProtocol({ trainerId: trainer.id, studentId: stored.id, trainings: BASE_TRAININGS });
      await createProtocol({ trainerId: trainer.id, studentId: fresh.id, trainings: BASE_TRAININGS });
      await prisma.consistencyWeeklyTarget.createMany({
        data: [
          { trainerId: trainer.id, studentId: stored.id, weekStart: WEEK_START_DATE, pillar: Pillar.WORKOUTS, expected: 5 },
          { trainerId: trainer.id, studentId: stored.id, weekStart: WEEK_START_DATE, pillar: Pillar.CARDIO, expected: 0 },
        ],
      });

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, [stored.id, fresh.id]);

      expect(result.get(stored.id)).toEqual({ workouts: 5, cardio: 0 });
      expect(result.get(fresh.id)).toEqual({ workouts: 2, cardio: 1 });
    });

    it('is safe under concurrent runs', async () => {
      const trainer = await createTrainer();
      const student = await createUser('target-student');
      await createProtocol({ trainerId: trainer.id, studentId: student.id, trainings: BASE_TRAININGS });

      const results = await Promise.all(
        Array.from({ length: CONCURRENT_RUNS }, () => materializeTargets(prisma, trainer.id, WEEK_START, [student.id])),
      );

      expect(results.map((result) => result.get(student.id))).toEqual(
        Array(CONCURRENT_RUNS).fill({ workouts: 2, cardio: 1 }),
      );
      expect(await prisma.consistencyWeeklyTarget.count({ where: { trainerId: trainer.id } })).toBe(2);
    });

    it('returns an empty map for no students', async () => {
      const trainer = await createTrainer();

      const result = await materializeTargets(prisma, trainer.id, WEEK_START, []);

      expect(result.size).toBe(0);
    });
  });

  describe('countDone', () => {
    const window = { from: DONE_FROM, to: DONE_TO };

    it('RANK-04 counts completed sessions inside the done window', async () => {
      const trainer = await createTrainer();
      const student = await createUser('done-student');
      const trainings = await createDoneSetup({ trainerId: trainer.id, studentId: student.id });
      const base = { trainingId: trainings[TrainingCategory.STRENGTH].id, studentId: student.id };
      await createSession({ ...base, finishedAt: INSIDE_WINDOW });
      await createSession({ ...base, finishedAt: DONE_TO });
      await createSession({ ...base, finishedAt: DONE_FROM });
      await createSession({ ...base, finishedAt: BEFORE_WINDOW });
      await createSession({ ...base, finishedAt: AFTER_WINDOW });
      await createSession({ ...base, finishedAt: INSIDE_WINDOW, status: WorkoutSessionStatus.IN_PROGRESS });
      await createSession({ ...base, finishedAt: INSIDE_WINDOW, deletedAt: INSIDE_WINDOW });

      const result = await countDone(prisma, trainer.id, [student.id], window);

      expect(result.get(student.id)).toEqual({ workouts: 2, cardio: 0 });
    });

    it("RANK-49 ignores sessions of another trainer's protocol", async () => {
      const trainer = await createTrainer();
      const otherTrainer = await createTrainer();
      const student = await createUser('done-student');
      const own = await createDoneSetup({ trainerId: trainer.id, studentId: student.id });
      const other = await createDoneSetup({ trainerId: otherTrainer.id, studentId: student.id });
      const base = { studentId: student.id, finishedAt: INSIDE_WINDOW };
      await createSession({ ...base, trainingId: own[TrainingCategory.STRENGTH].id });
      await createSession({ ...base, trainingId: other[TrainingCategory.STRENGTH].id });
      await createSession({ ...base, trainingId: other[TrainingCategory.CARDIO].id });

      const result = await countDone(prisma, trainer.id, [student.id], window);

      expect(result.get(student.id)).toEqual({ workouts: 1, cardio: 0 });
    });

    it('RANK-50 counts a repeated training twice', async () => {
      const trainer = await createTrainer();
      const student = await createUser('done-student');
      const trainings = await createDoneSetup({ trainerId: trainer.id, studentId: student.id });
      const base = { trainingId: trainings[TrainingCategory.STRENGTH].id, studentId: student.id };
      await createSession({ ...base, finishedAt: INSIDE_WINDOW });
      await createSession({ ...base, finishedAt: new Date('2030-01-10T12:00:00.000Z') });

      const result = await countDone(prisma, trainer.id, [student.id], window);

      expect(result.get(student.id)).toEqual({ workouts: 2, cardio: 0 });
    });

    it('RANK-53 counts a cardio session as cardio and a rest session nowhere', async () => {
      const trainer = await createTrainer();
      const student = await createUser('done-student');
      const trainings = await createDoneSetup({ trainerId: trainer.id, studentId: student.id });
      const base = { studentId: student.id, finishedAt: INSIDE_WINDOW };
      await createSession({ ...base, trainingId: trainings[TrainingCategory.CARDIO].id });
      await createSession({ ...base, trainingId: trainings[TrainingCategory.REST].id });
      await createSession({ ...base, trainingId: trainings[TrainingCategory.STRENGTH].id });

      const result = await countDone(prisma, trainer.id, [student.id], window);

      expect(result.get(student.id)).toEqual({ workouts: 1, cardio: 1 });
    });

    it('returns zeros for students without sessions and keeps students apart', async () => {
      const trainer = await createTrainer();
      const active = await createUser('done-active');
      const idle = await createUser('done-idle');
      const trainings = await createDoneSetup({ trainerId: trainer.id, studentId: active.id });
      await createSession({
        trainingId: trainings[TrainingCategory.CARDIO].id,
        studentId: active.id,
        finishedAt: INSIDE_WINDOW,
      });

      const result = await countDone(prisma, trainer.id, [active.id, idle.id], window);

      expect(result.get(active.id)).toEqual({ workouts: 0, cardio: 1 });
      expect(result.get(idle.id)).toEqual({ workouts: 0, cardio: 0 });
      expect(result.size).toBe(2);
    });

    it('returns an empty map for no students', async () => {
      const trainer = await createTrainer();

      const result = await countDone(prisma, trainer.id, [], window);

      expect(result.size).toBe(0);
    });
  });

  describe('closeDueWeeks', () => {
    const WEEK_B_DATE = new Date(Date.UTC(2030, 0, 14));
    const BEFORE_CLOSE_A = new Date('2030-01-13T23:59:59.000Z');
    const CLOSE_A = new Date('2030-01-14T00:00:00.000Z');
    const NOW_AFTER_A = new Date('2030-01-14T00:15:00.000Z');
    const NOW_AFTER_B = new Date('2030-01-21T00:15:00.000Z');
    const SUNDAY_BEFORE_NEXT_MONDAY = new Date('2030-01-21T00:30:00.000Z');
    const NEXT_MONDAY_OPEN = new Date('2030-01-21T03:05:00.000Z');
    const SESSION_A = new Date('2030-01-09T12:00:00.000Z');
    const LATE_SESSION = new Date('2030-01-14T02:00:00.000Z');
    const SESSION_B = new Date('2030-01-16T12:00:00.000Z');
    const LINKED_AFTER_MONDAY = new Date('2030-01-08T12:00:00.000Z');
    const DEFAULT_WEIGHTS = { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 };
    const DEFAULT_PILLARS = [Pillar.WORKOUTS, Pillar.CARDIO, Pillar.FEEDBACK, Pillar.HYDRATION];
    const originalLaunchWeek = process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;

    beforeEach(() => {
      process.env.CONSISTENCY_RANKING_LAUNCH_WEEK = '2030-01-07';
    });

    afterEach(() => {
      if (originalLaunchWeek === undefined) delete process.env.CONSISTENCY_RANKING_LAUNCH_WEEK;
      else process.env.CONSISTENCY_RANKING_LAUNCH_WEEK = originalLaunchWeek;
    });

    it('RANK-10 writes one result per active student', async () => {
      const { trainer, season } = await createTrainerWithSeason();
      const partial = await createLinkedStudent(trainer.id);
      const perfect = await createLinkedStudent(trainer.id);
      const noPlan = await createLinkedStudent(trainer.id, { withProtocol: false });
      const lateLink = await createLinkedStudent(trainer.id, { createdAt: LINKED_AFTER_MONDAY });
      const pausedStudent = await createLinkedStudent(trainer.id);
      await createLinkedStudent(trainer.id, { activeOnPlan: false });
      await completeSessions(partial, { strength: 1, cardio: 1, at: SESSION_A });
      await completeSessions(perfect, { strength: 2, cardio: 1, at: SESSION_A });
      await completeSessions(pausedStudent, { strength: 1, at: SESSION_A });
      await prisma.consistencyWeekPause.create({
        data: { trainerId: trainer.id, studentId: pausedStudent.id, weekStart: WEEK_START_DATE, paused: true },
      });
      const logger = createLogger();

      await closeDueWeeks(prisma, logger, NOW_AFTER_A);

      const rows = await resultsByStudent(trainer.id);
      expect(Object.keys(rows)).toHaveLength(5);
      expect(rows[partial.id]).toMatchObject({
        seasonId: season.id,
        status: WeekStatus.VALID,
        pillars: { workouts: { expected: 2, done: 1 }, cardio: { expected: 1, done: 1 } },
        weights: { weights: DEFAULT_WEIGHTS, activePillars: DEFAULT_PILLARS },
        closedAt: NOW_AFTER_A,
      });
      expect(rows[partial.id].score.toFixed(4)).toBe('66.6667');
      expect(rows[perfect.id].status).toBe(WeekStatus.VALID);
      expect(rows[perfect.id].score.toFixed(4)).toBe('100.0000');
      expect(rows[perfect.id].pillars).toEqual({ workouts: { expected: 2, done: 2 }, cardio: { expected: 1, done: 1 } });
      expect(rows[noPlan.id]).toMatchObject({
        status: WeekStatus.NEUTRAL,
        score: null,
        pillars: { workouts: { expected: 0, done: 0 }, cardio: { expected: 0, done: 0 } },
      });
      expect(rows[lateLink.id]).toMatchObject({
        status: WeekStatus.NEUTRAL,
        score: null,
        pillars: { workouts: { expected: 2, done: 0 }, cardio: { expected: 1, done: 0 } },
      });
      expect(rows[pausedStudent.id]).toMatchObject({
        status: WeekStatus.PAUSED,
        score: null,
        pillars: { workouts: { expected: 2, done: 1 }, cardio: { expected: 1, done: 0 } },
      });
      const marks = await prisma.consistencyWeekClose.findMany({ where: { trainerId: trainer.id } });
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ weekStart: WEEK_START_DATE, studentsCount: 5, closedAt: NOW_AFTER_A });
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0][0]).toMatchObject({ trainerId: trainer.id, weekStart: '2030-01-07', studentsCount: 5 });
      const stillActive = await prisma.consistencySeason.findUnique({ where: { id: season.id } });
      expect(stillActive).toMatchObject({ status: SeasonStatus.ACTIVE, closedAt: null });
      expect(await prisma.consistencySeasonStanding.count({ where: { trainerId: trainer.id } })).toBe(0);
    });

    it('does not close a week before its close instant and closes it exactly at it', async () => {
      const { trainer } = await createTrainerWithSeason();
      await createLinkedStudent(trainer.id);

      await closeDueWeeks(prisma, createLogger(), BEFORE_CLOSE_A);
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(0);

      await closeDueWeeks(prisma, createLogger(), CLOSE_A);
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);
    });

    it('closes a week by the trainer rule and timezone', async () => {
      const { trainer } = await createTrainerWithSeason();
      await createLinkedStudent(trainer.id);
      await prisma.consistencyScoringRule.create({
        data: {
          trainerId: trainer.id,
          effectiveFrom: new Date(Date.UTC(2030, 0, 1)),
          weights: DEFAULT_WEIGHTS,
          activePillars: DEFAULT_PILLARS,
          closeWeekday: 3,
          closeHour: 10,
          timeZone: 'UTC',
        },
      });

      await closeDueWeeks(prisma, createLogger(), new Date('2030-01-09T09:59:59.000Z'));
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(0);

      await closeDueWeeks(prisma, createLogger(), new Date('2030-01-09T10:00:00.000Z'));
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);
    });

    it('RANK-11 is idempotent when run twice', async () => {
      const { trainer } = await createTrainerWithSeason();
      const student = await createLinkedStudent(trainer.id);
      await completeSessions(student, { strength: 1, at: SESSION_A });
      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);
      const firstResults = await storedResults(trainer.id);
      const firstMarks = await prisma.consistencyWeekClose.findMany({ where: { trainerId: trainer.id } });
      const logger = createLogger();

      await closeDueWeeks(prisma, logger, new Date('2030-01-14T00:45:00.000Z'));

      expect(await storedResults(trainer.id)).toEqual(firstResults);
      expect(await prisma.consistencyWeekClose.findMany({ where: { trainerId: trainer.id } })).toEqual(firstMarks);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('keeps an already stored result when the closed-week mark is missing', async () => {
      const { trainer, season } = await createTrainerWithSeason();
      const student = await createLinkedStudent(trainer.id);
      await prisma.consistencyWeeklyResult.create({
        data: {
          trainerId: trainer.id,
          studentId: student.id,
          seasonId: season.id,
          weekStart: WEEK_START_DATE,
          status: WeekStatus.VALID,
          score: '55.5000',
          pillars: { workouts: { expected: 9, done: 5 }, cardio: { expected: 0, done: 0 } },
          weights: { stored: true },
          closedAt: BEFORE_MONDAY,
        },
      });
      const [stored] = await storedResults(trainer.id);

      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);

      expect(await storedResults(trainer.id)).toEqual([stored]);
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);
    });

    it('RANK-12 closes a week once under concurrent runs', async () => {
      const first = await createTrainerWithSeason();
      const second = await createTrainerWithSeason();
      for (const { trainer } of [first, second]) {
        await createLinkedStudent(trainer.id);
        await createLinkedStudent(trainer.id);
      }
      const logger = createLogger();

      await Promise.all(Array.from({ length: CONCURRENT_RUNS }, () => closeDueWeeks(prisma, logger, NOW_AFTER_A)));

      for (const { trainer } of [first, second]) {
        expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);
        expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: trainer.id } })).toBe(2);
      }
      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('RANK-13 isolates a failing trainer and retries next run', async () => {
      const [failing, healthy] = [await createTrainerWithSeason(), await createTrainerWithSeason()].sort((a, b) =>
        a.trainer.id.localeCompare(b.trainer.id),
      );
      for (const { trainer } of [failing, healthy]) {
        const student = await createLinkedStudent(trainer.id);
        await completeSessions(student, { strength: 2, cardio: 1, at: SESSION_A });
      }
      const logger = createLogger();

      await closeDueWeeks(prismaFailingMarkFor(failing.trainer.id), logger, NOW_AFTER_A);

      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: healthy.trainer.id } })).toBe(1);
      expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: healthy.trainer.id } })).toBe(1);
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: failing.trainer.id } })).toBe(0);
      expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: failing.trainer.id } })).toBe(0);
      expect(await prisma.consistencyWeeklyTarget.count({ where: { trainerId: failing.trainer.id } })).toBe(0);
      expect(await prisma.consistencySeasonStanding.count({ where: { trainerId: failing.trainer.id } })).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields, message] = logger.error.mock.calls[0];
      expect(fields).toMatchObject({ trainerId: failing.trainer.id, weekStart: '2030-01-07' });
      expect(fields.err.message).toBe('injected close failure');
      expect(message).toContain(failing.trainer.id);
      expect(message).toContain('2030-01-07');
      expect(logger.info).toHaveBeenCalledTimes(1);

      const retryLogger = createLogger();
      await closeDueWeeks(prisma, retryLogger, new Date('2030-01-14T00:30:00.000Z'));

      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: failing.trainer.id } })).toBe(1);
      expect((await storedResults(failing.trainer.id))[0].score.toFixed(4)).toBe('100.0000');
      expect(retryLogger.info).toHaveBeenCalledTimes(1);
      expect(retryLogger.info.mock.calls[0][0]).toMatchObject({ trainerId: failing.trainer.id, weekStart: '2030-01-07' });
      expect(retryLogger.error).not.toHaveBeenCalled();
      expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: healthy.trainer.id } })).toBe(1);
    });

    it('RANK-14 keeps a closed result after a late session', async () => {
      const { trainer } = await createTrainerWithSeason({ weeks: 3 });
      const student = await createLinkedStudent(trainer.id);
      await completeSessions(student, { strength: 1, at: SESSION_A });
      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);
      const closed = await storedResults(trainer.id);
      expect(closed[0].score.toFixed(4)).toBe('33.3333');

      await completeSessions(student, { strength: 1, cardio: 1, at: LATE_SESSION });
      await completeSessions(student, { strength: 1, cardio: 1, at: SESSION_A });
      await closeDueWeeks(prisma, createLogger(), new Date('2030-01-14T06:00:00.000Z'));

      expect(await storedResults(trainer.id)).toEqual(closed);
    });

    it('RANK-15 keeps closed results after config changes', async () => {
      const { trainer } = await createTrainerWithSeason({ weeks: 3 });
      const student = await createLinkedStudent(trainer.id);
      await completeSessions(student, { strength: 1, cardio: 1, at: SESSION_A });
      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);
      const closed = await storedResults(trainer.id);
      const newWeights = { workouts: 50, diet: 0, cardio: 50, feedback: 0, hydration: 0 };

      await updateConfig(prisma, trainer.id, { weights: newWeights, activePillars: [Pillar.WORKOUTS, Pillar.CARDIO] }, NOW_AFTER_A);
      await prisma.trainingProtocol.updateMany({ where: { trainerId: trainer.id }, data: { status: TrainingStatus.ARCHIVED } });
      await prisma.consistencyWeeklyTarget.updateMany({ where: { trainerId: trainer.id }, data: { expected: 99 } });

      expect(await storedResults(trainer.id)).toEqual(closed);

      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_B);
      const all = await storedResults(trainer.id);
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual(closed[0]);
      expect(all[0].weights).toEqual({ weights: DEFAULT_WEIGHTS, activePillars: DEFAULT_PILLARS });
      expect(all[1]).toMatchObject({
        weekStart: WEEK_B_DATE,
        weights: { weights: newWeights, activePillars: [Pillar.WORKOUTS, Pillar.CARDIO] },
      });
    });

    it('RANK-17 freezes standings and opens the next season', async () => {
      const { trainer, season } = await createTrainerWithSeason({ weeks: 2 });
      const partial = await createLinkedStudent(trainer.id, { firstName: 'Bia' });
      const perfect = await createLinkedStudent(trainer.id, { firstName: 'Ana' });
      const pausedInB = await createLinkedStudent(trainer.id, { firstName: 'Caio' });
      const lateLink = await createLinkedStudent(trainer.id, { createdAt: new Date('2030-01-22T12:00:00.000Z') });
      await completeSessions(partial, { strength: 1, cardio: 1, at: SESSION_A });
      await completeSessions(perfect, { strength: 2, cardio: 1, at: SESSION_A });
      await completeSessions(pausedInB, { strength: 1, at: SESSION_A });
      await completeSessions(partial, { strength: 2, cardio: 1, at: SESSION_B });
      await completeSessions(perfect, { strength: 2, cardio: 1, at: SESSION_B });
      await prisma.consistencyWeekPause.create({
        data: { trainerId: trainer.id, studentId: pausedInB.id, weekStart: WEEK_B_DATE, paused: true },
      });
      const logger = createLogger();

      await closeDueWeeks(prisma, logger, NOW_AFTER_B);

      expect(logger.error).not.toHaveBeenCalled();
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(2);
      expect(logger.info.mock.calls.map(([fields]) => fields.weekStart)).toEqual(['2030-01-07', '2030-01-14']);
      const closedSeason = await prisma.consistencySeason.findUnique({ where: { id: season.id } });
      expect(closedSeason).toMatchObject({ status: SeasonStatus.CLOSED, closedAt: NOW_AFTER_B });
      const standings = await prisma.consistencySeasonStanding.findMany({ where: { seasonId: season.id } });
      const byStudent = Object.fromEntries(standings.map((row) => [row.studentId, row]));
      expect(standings).toHaveLength(4);
      expect(byStudent[perfect.id]).toMatchObject({ position: 1, eligible: true, validWeeks: 2, weeks100: 2, streak: 2, frozenAt: NOW_AFTER_B });
      expect(byStudent[perfect.id].average.toFixed(4)).toBe('100.0000');
      expect(byStudent[partial.id]).toMatchObject({ position: 2, eligible: true, validWeeks: 2, weeks100: 1, streak: 1 });
      expect(byStudent[partial.id].average.toFixed(4)).toBe('83.3334');
      expect(byStudent[pausedInB.id]).toMatchObject({ position: null, eligible: false, validWeeks: 1, weeks100: 0, streak: 0 });
      expect(byStudent[pausedInB.id].average.toFixed(4)).toBe('33.3333');
      expect(byStudent[lateLink.id]).toMatchObject({ position: null, eligible: false, validWeeks: 0, average: null });

      const frozen = await getStandings(prisma, trainer.id, { seasonNumber: 1, now: NOW_AFTER_B });
      expect(frozen.rows.map((row) => [row.name, row.position])).toEqual([['Ana', 1], ['Bia', 2]]);
      expect(frozen.entering.map((row) => row.name)).toEqual(['Caio']);

      await prepareCurrentWeek(prisma, SUNDAY_BEFORE_NEXT_MONDAY);
      expect(await prisma.consistencySeason.count({ where: { trainerId: trainer.id } })).toBe(1);

      await prepareCurrentWeek(prisma, NEXT_MONDAY_OPEN);
      const seasons = await prisma.consistencySeason.findMany({ where: { trainerId: trainer.id }, orderBy: { number: 'asc' } });
      expect(seasons).toHaveLength(2);
      expect(seasons[1]).toMatchObject({ number: 2, startWeek: new Date(Date.UTC(2030, 0, 21)), weeks: 4, status: SeasonStatus.ACTIVE });
      const nextTargets = await prisma.consistencyWeeklyTarget.findMany({
        where: { trainerId: trainer.id, studentId: partial.id, weekStart: new Date(Date.UTC(2030, 0, 21)) },
      });
      expect(Object.fromEntries(nextTargets.map((row) => [row.pillar, row.expected]))).toEqual({ workouts: 2, cardio: 1 });
    });

    it('RANK-17 opens the next season on the current Monday after a late close', async () => {
      const { trainer } = await createTrainerWithSeason({ weeks: 1 });
      const student = await createLinkedStudent(trainer.id);
      await completeSessions(student, { strength: 2, cardio: 1, at: SESSION_A });
      const lateTuesday = new Date('2030-01-15T15:00:00.000Z');

      await closeDueWeeks(prisma, createLogger(), lateTuesday);
      await prepareCurrentWeek(prisma, lateTuesday);

      const seasons = await prisma.consistencySeason.findMany({ where: { trainerId: trainer.id }, orderBy: { number: 'asc' } });
      expect(seasons).toHaveLength(2);
      expect(seasons[0]).toMatchObject({ status: SeasonStatus.CLOSED, closedAt: lateTuesday });
      expect(seasons[1]).toMatchObject({ number: 2, startWeek: WEEK_B_DATE, status: SeasonStatus.ACTIVE });
    });

    it('RANK-45 ends the season at the next close and opens the next one on Monday', async () => {
      const { trainer, season } = await createTrainerWithSeason({ weeks: 4 });
      const student = await createLinkedStudent(trainer.id);
      await completeSessions(student, { strength: 2, cardio: 1, at: SESSION_A });
      await requestEarlyClose(prisma, trainer.id, new Date('2030-01-09T12:00:00.000Z'));

      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);

      const closedSeason = await prisma.consistencySeason.findUnique({ where: { id: season.id } });
      expect(closedSeason).toMatchObject({ status: SeasonStatus.CLOSED, closedAt: NOW_AFTER_A });
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);
      const [standing] = await prisma.consistencySeasonStanding.findMany({ where: { seasonId: season.id } });
      expect(standing).toMatchObject({ studentId: student.id, position: 1, eligible: true, validWeeks: 1, weeks100: 1, streak: 1 });
      expect(standing.average.toFixed(4)).toBe('100.0000');

      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_B);
      expect(await prisma.consistencyWeekClose.count({ where: { trainerId: trainer.id } })).toBe(1);

      await prepareCurrentWeek(prisma, new Date('2030-01-13T23:30:00.000Z'));
      expect(await prisma.consistencySeason.count({ where: { trainerId: trainer.id } })).toBe(1);

      await prepareCurrentWeek(prisma, new Date('2030-01-14T03:05:00.000Z'));
      const next = await prisma.consistencySeason.findFirst({ where: { trainerId: trainer.id, number: 2 } });
      expect(next).toMatchObject({ startWeek: WEEK_B_DATE, status: SeasonStatus.ACTIVE });
    });

    it('prepareCurrentWeek creates one season under concurrent runs and skips trainers without active students', async () => {
      const { trainer } = await createTrainerWithSeason();
      await prisma.consistencySeason.update({
        where: { trainerId_number: { trainerId: trainer.id, number: 1 } },
        data: { status: SeasonStatus.CLOSED, closedAt: new Date('2030-01-01T00:00:00.000Z') },
      });
      await createLinkedStudent(trainer.id);
      const idle = await createTrainer();
      await createLinkedStudent(idle.id, { activeOnPlan: false });
      const logger = createLogger();

      await Promise.all(Array.from({ length: CONCURRENT_RUNS }, () => prepareCurrentWeek(prisma, AFTER_MONDAY, logger)));

      const seasons = await prisma.consistencySeason.findMany({ where: { trainerId: trainer.id }, orderBy: { number: 'asc' } });
      expect(seasons.map((row) => row.number)).toEqual([1, 2]);
      expect(await prisma.consistencySeason.count({ where: { trainerId: idle.id } })).toBe(0);
      expect(await prisma.consistencyWeeklyTarget.count({ where: { trainerId: trainer.id } })).toBe(2);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('RANK-54 keeps results after unlinking the student', async () => {
      const { trainer, season } = await createTrainerWithSeason({ weeks: 2 });
      const leaver = await createLinkedStudent(trainer.id, { firstName: 'Bia' });
      const stayer = await createLinkedStudent(trainer.id, { firstName: 'Ana' });
      await completeSessions(leaver, { strength: 2, cardio: 1, at: SESSION_A });
      await completeSessions(stayer, { strength: 2, cardio: 1, at: SESSION_A });
      await completeSessions(stayer, { strength: 2, cardio: 1, at: SESSION_B });
      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_A);

      await unlinkStudent({ trainerId: trainer.id, studentId: leaver.id });

      const afterUnlink = await prisma.consistencyWeeklyResult.findMany({ where: { trainerId: trainer.id, studentId: leaver.id } });
      expect(afterUnlink).toHaveLength(1);
      expect(afterUnlink[0].score.toFixed(4)).toBe('100.0000');

      await closeDueWeeks(prisma, createLogger(), NOW_AFTER_B);
      const standings = await prisma.consistencySeasonStanding.findMany({ where: { seasonId: season.id } });
      expect(standings.map((row) => row.studentId).sort()).toEqual([leaver.id, stayer.id].sort());
      const leaverStanding = standings.find((row) => row.studentId === leaver.id);
      expect(leaverStanding).toMatchObject({ eligible: false, position: null, validWeeks: 1, weeks100: 1 });
      expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: trainer.id, studentId: leaver.id } })).toBe(1);

      await unlinkStudent({ trainerId: trainer.id, studentId: stayer.id });

      expect(await prisma.consistencySeasonStanding.count({ where: { seasonId: season.id } })).toBe(2);
      expect(await prisma.consistencyWeeklyResult.count({ where: { trainerId: trainer.id } })).toBe(3);
      const frozen = await getStandings(prisma, trainer.id, { seasonNumber: 1, now: NOW_AFTER_B });
      expect(frozen.rows.map((row) => row.name)).toEqual(['Ana']);
      expect(frozen.entering.map((row) => row.name)).toEqual(['Bia']);
    });
  });
});

import 'dotenv/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { Pillar } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays } from '../../src/constants/training.js';

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
});

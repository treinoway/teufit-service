import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { listChallenges } from '../../src/services/challenge-service.js';
import { ChallengeFormat, ChallengeParticipantMode } from '../../src/constants/challenge.js';
import { DEFAULT_CONFIG, Pillar } from '../../src/constants/consistency-ranking.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MIGRATION_NAME = '20261122120000_challenge_scoring_rule';
const MIGRATIONS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const migrationSql = readFileSync(path.join(MIGRATIONS_DIRECTORY, MIGRATION_NAME, 'migration.sql'), 'utf8');

// The backfill UPDATE statements of the migration (the columns already exist in the test database)
const backfillStatements = migrationSql.match(/^UPDATE[\s\S]*?;/gm) ?? [];

const EARLY_RULE = {
  weights: { workouts: 60, diet: 0, cardio: 40, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
};
const LATER_RULE = {
  weights: { workouts: 100, diet: 0, cardio: 0, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS],
};

// Midnight-UTC Date of a "YYYY-MM-DD" civil date, as @db.Date columns hold it
function civilDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

let counter = 0;

// User and trainer rows of a new trainer
async function createTrainer() {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `e2e+scoring-trainer-${Date.now()}-${counter}@example.com`, roles: [] },
  });
  const trainer = await prisma.trainer.create({ data: { userId: user.id } });
  return { userId: user.id, trainerId: trainer.id };
}

// Scoring rule of a trainer effective from a Monday
function createRule(trainerId, effectiveFrom, rule) {
  return prisma.consistencyScoringRule.create({
    data: {
      trainerId,
      effectiveFrom: civilDate(effectiveFrom),
      weights: rule.weights,
      activePillars: rule.activePillars,
      closeWeekday: DEFAULT_CONFIG.closeWeekday,
      closeHour: DEFAULT_CONFIG.closeHour,
      timeZone: DEFAULT_CONFIG.timeZone,
    },
  });
}

// Championship row stored without a scoring rule, as before the migration
function createStoredChallenge(trainerId, { format = ChallengeFormat.WEEKS, startDate, endDate }) {
  return prisma.challenge.create({
    data: {
      trainerId,
      name: `Campeonato ${startDate}`,
      startDate: civilDate(startDate),
      endDate: civilDate(endDate),
      participantMode: ChallengeParticipantMode.EXPLICIT,
      format,
      ...(format === ChallengeFormat.WEEKS ? { weeks: 2, minPodiumWeeks: 1 } : {}),
    },
  });
}

// Student user linked to the trainer
async function createStudent(trainerId, { firstName, lastName, avatarUrl = null }) {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `e2e+scoring-student-${Date.now()}-${counter}@example.com`, roles: [], firstName, lastName, avatarUrl },
  });
  await prisma.trainerStudent.create({ data: { trainerId, studentId: user.id } });
  return user;
}

// Participants joining a championship one minute apart, in the given order
async function joinInOrder(challengeId, students) {
  const firstJoin = new Date('2026-11-16T12:00:00.000Z').getTime();
  for (const [index, student] of students.entries()) {
    await prisma.challengeParticipant.create({
      data: { challengeId, studentId: student.id, createdAt: new Date(firstJoin + index * 60000) },
    });
  }
}

// Preview entry the list returns for a student
function previewOf(student) {
  return { studentId: student.id, firstName: student.firstName, lastName: student.lastName, avatarUrl: student.avatarUrl };
}

// Stored scoring rule of a championship
async function storedRuleOf(challengeId) {
  const { weights, activePillars } = await prisma.challenge.findUnique({
    where: { id: challengeId },
    select: { weights: true, activePillars: true },
  });
  return { weights, activePillars };
}

e2eDescribe('challenge scoring', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it('CPD-18 backfills existing weekly championships with the rule in force on their start Monday', async () => {
    const { trainerId } = await createTrainer();
    const { trainerId: trainerWithoutRule } = await createTrainer();
    await createRule(trainerId, '2026-11-02', EARLY_RULE);
    await createRule(trainerId, '2026-11-16', LATER_RULE);
    const beforeAnyRule = await createStoredChallenge(trainerId, { startDate: '2026-10-26', endDate: '2026-11-08' });
    const underEarlyRule = await createStoredChallenge(trainerId, { startDate: '2026-11-09', endDate: '2026-11-22' });
    const onLaterRuleMonday = await createStoredChallenge(trainerId, { startDate: '2026-11-16', endDate: '2026-11-29' });
    const withoutRule = await createStoredChallenge(trainerWithoutRule, { startDate: '2026-11-16', endDate: '2026-11-29' });
    const freeDates = await createStoredChallenge(trainerId, {
      format: ChallengeFormat.DATES, startDate: '2026-11-10', endDate: '2026-11-20',
    });
    const defaults = { weights: { ...DEFAULT_CONFIG.weights }, activePillars: [...DEFAULT_CONFIG.activePillars] };

    expect(await storedRuleOf(underEarlyRule.id)).toEqual({ weights: null, activePillars: [] });
    expect(backfillStatements.length).toBeGreaterThan(0);
    for (const statement of backfillStatements) await prisma.$executeRawUnsafe(statement);

    expect(await storedRuleOf(beforeAnyRule.id)).toEqual(defaults);
    expect(await storedRuleOf(underEarlyRule.id)).toEqual(EARLY_RULE);
    expect(await storedRuleOf(onLaterRuleMonday.id)).toEqual(LATER_RULE);
    expect(await storedRuleOf(withoutRule.id)).toEqual(defaults);
    expect(await storedRuleOf(freeDates.id)).toEqual({ weights: null, activePillars: [] });
  });

  it('CPD-65 lists up to four participants per championship with names and avatar', async () => {
    const { userId, trainerId } = await createTrainer();
    const { trainerId: otherTrainerId } = await createTrainer();
    const students = [];
    for (const [index, avatarUrl] of ['https://cdn.example.com/a.png', null, 'https://cdn.example.com/c.png', null, 'https://cdn.example.com/e.png'].entries()) {
      students.push(await createStudent(trainerId, { firstName: `Aluno${index + 1}`, lastName: `Sobrenome${index + 1}`, avatarUrl }));
    }
    const crowded = await createStoredChallenge(trainerId, { startDate: '2026-11-16', endDate: '2026-11-29' });
    const small = await createStoredChallenge(trainerId, {
      format: ChallengeFormat.DATES, startDate: '2026-11-20', endDate: '2026-11-30',
    });
    const empty = await createStoredChallenge(trainerId, { startDate: '2026-11-23', endDate: '2026-12-06' });
    const foreign = await createStoredChallenge(otherTrainerId, { startDate: '2026-11-16', endDate: '2026-11-29' });
    const joinOrder = [students[3], students[0], students[4], students[1], students[2]];
    await joinInOrder(crowded.id, joinOrder);
    await joinInOrder(small.id, [students[2], students[0]]);
    await joinInOrder(foreign.id, [students[1]]);

    const listed = await listChallenges({ prisma, trainerUserId: userId, now: new Date('2026-11-18T15:00:00.000Z') });

    const byId = Object.fromEntries(listed.map((challenge) => [challenge.id, challenge]));
    expect(Object.keys(byId).sort()).toEqual([crowded.id, small.id, empty.id].sort());
    expect(byId[crowded.id].participantCount).toBe(5);
    expect(byId[crowded.id].participantsPreview).toEqual(joinOrder.slice(0, 4).map(previewOf));
    expect(byId[small.id].participantsPreview).toEqual([students[2], students[0]].map(previewOf));
    expect(byId[empty.id].participantsPreview).toEqual([]);
  });
});

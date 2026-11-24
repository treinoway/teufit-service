import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { setupApp } from '../helpers/setup-app.js';
import { signupVerified } from '../helpers/signup-user.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { listChallenges } from '../../src/services/challenge-service.js';
import { weekStartFor } from '../../src/helpers/consistency-week.js';
import {
  ChallengeErrorCode,
  ChallengeFormat,
  ChallengeMessageCode,
  ChallengeParticipantMode,
  ChallengeStatus,
} from '../../src/constants/challenge.js';
import { DEFAULT_CONFIG, Pillar } from '../../src/constants/consistency-ranking.js';
import { PointAction } from '../../src/constants/gamification.js';

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

const CUSTOM_RULE = {
  weights: { workouts: 70, diet: 0, cardio: 30, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
};
const DEFAULT_RULE = { weights: { ...DEFAULT_CONFIG.weights }, activePillars: [...DEFAULT_CONFIG.activePillars] };
const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// "YYYY-MM-DD" of a midnight-UTC Date
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Midnight-UTC Date of the Monday `offset` weeks from the current one, in the default trainer time zone
function mondayAt(offset) {
  const { year, month, day } = weekStartFor(new Date(), DEFAULT_CONFIG.timeZone);
  return new Date(Date.UTC(year, month - 1, day) + offset * MS_PER_WEEK);
}

// "YYYY-MM-DD" of today plus `days` in UTC
function utcDay(days) {
  const now = new Date();
  return dateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)));
}

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

  async function createTrainerWithToken() {
    counter += 1;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `trainer+scoring+${Date.now()}-${counter}@example.com`, password: 'StrongPassw0rd!' },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();
    const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${accessToken}` } });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
  }

  function call(token, method, url, payload) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  function createWeekly(token, overrides = {}) {
    return call(token, 'POST', '/trainer/challenges', {
      name: 'Campeonato de pontuação',
      format: ChallengeFormat.WEEKS,
      startWeek: dateKey(mondayAt(1)),
      weeks: 4,
      participantMode: ChallengeParticipantMode.EXPLICIT,
      studentIds: [],
      ...overrides,
    });
  }

  function seedWeekly(trainerId, { start, weeks = 2, rule = CUSTOM_RULE, ...columns }) {
    return prisma.challenge.create({
      data: {
        trainerId,
        name: 'Semeado',
        format: ChallengeFormat.WEEKS,
        weeks,
        minPodiumWeeks: 1,
        startDate: start,
        endDate: new Date(start.getTime() + (weeks * 7 - 1) * MS_PER_DAY),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        weights: rule.weights,
        activePillars: rule.activePillars,
        ...columns,
      },
    });
  }

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

  it('CPD-06 stores the weights and active pillars sent on creation', async () => {
    const trainer = await createTrainerWithToken();

    const res = await createWeekly(trainer.token, CUSTOM_RULE);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ weights: CUSTOM_RULE.weights, activePillars: CUSTOM_RULE.activePillars });
    expect(await storedRuleOf(res.json().id)).toEqual(CUSTOM_RULE);
  });

  it('CPD-08 answers 400 challenge.scoringRule.invalid for weights that do not sum 100, miss a pillar or have an empty pillar list', async () => {
    const trainer = await createTrainerWithToken();
    const withoutHydration = Object.fromEntries(Object.entries(CUSTOM_RULE.weights).filter(([pillar]) => pillar !== Pillar.HYDRATION));
    const invalid = [
      [{ weights: { ...CUSTOM_RULE.weights, cardio: 20 }, activePillars: CUSTOM_RULE.activePillars }, 'weights'],
      [{ weights: withoutHydration, activePillars: CUSTOM_RULE.activePillars }, 'weights'],
      [{ weights: CUSTOM_RULE.weights, activePillars: [] }, 'activePillars'],
      [{ weights: CUSTOM_RULE.weights }, 'activePillars'],
    ];

    const responses = [];
    for (const [body] of invalid) responses.push(await createWeekly(trainer.token, body));

    expect(responses.map((res) => res.statusCode)).toEqual([400, 400, 400, 400]);
    expect(responses.map((res) => [res.json().error, res.json().messageCode, res.json().details.field])).toEqual(
      invalid.map(([, field]) => [
        ChallengeErrorCode.CHALLENGE_INVALID_SCORING_RULE,
        ChallengeMessageCode.CHALLENGE_INVALID_SCORING_RULE,
        field,
      ]),
    );
    expect(await prisma.challenge.count({ where: { trainerId: trainer.trainerId } })).toBe(0);
  });

  it('CPD-14 changes the weights of a scheduled championship', async () => {
    const trainer = await createTrainerWithToken();
    const created = (await createWeekly(trainer.token)).json();

    const res = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, CUSTOM_RULE);
    const invalid = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, {
      weights: { ...CUSTOM_RULE.weights, workouts: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: ChallengeStatus.SCHEDULED, ...CUSTOM_RULE });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      messageCode: ChallengeMessageCode.CHALLENGE_INVALID_SCORING_RULE,
      details: { field: 'weights' },
    });
    expect(await storedRuleOf(created.id)).toEqual(CUSTOM_RULE);
  });

  it('CPD-15 answers 409 when the weights of a running, closed or cancelled championship change', async () => {
    const trainer = await createTrainerWithToken();
    const running = (await createWeekly(trainer.token, { startWeek: dateKey(mondayAt(0)), ...CUSTOM_RULE })).json();
    const closed = await seedWeekly(trainer.trainerId, { start: mondayAt(-3), closedAt: new Date() });
    const cancelled = await seedWeekly(trainer.trainerId, { start: mondayAt(1), cancelledAt: new Date() });
    expect(running.status).toBe(ChallengeStatus.ACTIVE);

    const responses = [];
    for (const id of [running.id, closed.id, cancelled.id]) {
      responses.push(await call(trainer.token, 'PATCH', `/trainer/challenges/${id}`, LATER_RULE));
    }

    expect(responses.map((res) => res.statusCode)).toEqual([409, 409, 409]);
    expect(responses[0].json().messageCode).toBe(ChallengeMessageCode.CHALLENGE_ALREADY_STARTED);
    for (const id of [running.id, closed.id, cancelled.id]) expect(await storedRuleOf(id)).toEqual(CUSTOM_RULE);
  });

  it('CPD-16 returns the weights and active pillars in the championship detail', async () => {
    const trainer = await createTrainerWithToken();
    const weekly = (await createWeekly(trainer.token, CUSTOM_RULE)).json();
    const dates = (await call(trainer.token, 'POST', '/trainer/challenges', {
      name: 'Datas livres',
      startDate: utcDay(2),
      endDate: utcDay(12),
      participantMode: ChallengeParticipantMode.EXPLICIT,
      studentIds: [],
    })).json();

    const weeklyDetail = await call(trainer.token, 'GET', `/trainer/challenges/${weekly.id}`);
    const datesDetail = await call(trainer.token, 'GET', `/trainer/challenges/${dates.id}`);

    expect(weeklyDetail.statusCode).toBe(200);
    expect(weeklyDetail.json()).toMatchObject({ format: ChallengeFormat.WEEKS, ...CUSTOM_RULE });
    expect(datesDetail.statusCode).toBe(200);
    expect(datesDetail.json()).toMatchObject({ format: ChallengeFormat.DATES, weights: null, activePillars: [] });
  });

  it('CPD-17 keeps the championship weights after the ranking config changes', async () => {
    const trainer = await createTrainerWithToken();
    const created = (await createWeekly(trainer.token)).json();
    expect(created).toMatchObject(DEFAULT_RULE);

    const config = await call(trainer.token, 'PUT', '/trainer/consistency-ranking/config', CUSTOM_RULE);
    const detail = await call(trainer.token, 'GET', `/trainer/challenges/${created.id}`);

    expect(config.statusCode).toBe(200);
    expect(detail.json()).toMatchObject(DEFAULT_RULE);
    expect(await storedRuleOf(created.id)).toEqual(DEFAULT_RULE);
  });

  it('CPD-26 stores the trainer default XP rules on a weekly championship created without them', async () => {
    const trainer = await createTrainerWithToken();
    const xpRules = { ptsWorkoutCompleted: 25, ptsStreak7Days: 60, ptsStreak30Days: 300, ptsDailyCheckin: 3, ptsEvolutionRecord: 20, ptsWorkoutFeedback: 7, dailyPointsCap: 80 };
    await prisma.gamificationConfig.create({ data: { trainerId: trainer.trainerId, ...xpRules } });

    const res = await createWeekly(trainer.token);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject(xpRules);
    expect(await prisma.challenge.findUnique({ where: { id: res.json().id } })).toMatchObject(xpRules);
  });

  it('CPD-82 decides by the status at write time and answers 409 once the championship started', async () => {
    const trainer = await createTrainerWithToken();
    const created = (await createWeekly(trainer.token, { weeks: 2 })).json();
    const whileScheduled = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, CUSTOM_RULE);
    await prisma.challenge.update({
      where: { id: created.id },
      data: { startDate: mondayAt(0), endDate: new Date(mondayAt(2).getTime() - MS_PER_DAY) },
    });

    const afterStart = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, LATER_RULE);

    expect(whileScheduled.statusCode).toBe(200);
    expect(afterStart.statusCode).toBe(409);
    expect(afterStart.json().messageCode).toBe(ChallengeMessageCode.CHALLENGE_ALREADY_STARTED);
    expect(await storedRuleOf(created.id)).toEqual(CUSTOM_RULE);
  });

  it('CPD-65 returns the participants preview through the championship list route', async () => {
    const trainer = await createTrainerWithToken();
    const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima', avatarUrl: 'https://cdn.example.com/ana.png' });
    const challenge = await seedWeekly(trainer.trainerId, { start: mondayAt(1) });
    await joinInOrder(challenge.id, [ana]);

    const res = await call(trainer.token, 'GET', '/trainer/challenges');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ id: challenge.id, ...CUSTOM_RULE, participantsPreview: [previewOf(ana)] }]);
  });

  it('CPD-32 returns the summary through the consistency route', async () => {
    const trainer = await createTrainerWithToken();
    const [ana, bia, caio] = [
      await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima' }),
      await createStudent(trainer.trainerId, { firstName: 'Bia', lastName: 'Costa' }),
      await createStudent(trainer.trainerId, { firstName: 'Caio', lastName: 'Reis' }),
    ];
    const challenge = await seedWeekly(trainer.trainerId, { start: mondayAt(-3), closedAt: new Date() });
    const standing = (student, position, eligible, average, validWeeks) => ({
      challengeId: challenge.id, studentId: student.id, position, eligible, average, validWeeks, weeks100: 0, streak: 0, frozenAt: new Date(),
    });
    await prisma.challengeConsistencyStanding.createMany({
      data: [standing(ana, 1, true, 90, 2), standing(bia, 2, true, 75.5, 2), standing(caio, null, false, 60, 1)],
    });

    const res = await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`);

    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ classified: 2, entering: 1, leaderAverage: 90, leaderLead: 14.5, championshipAverage: 82.75 });
  });

  it('CPD-38 returns the XP figures per entry through the ranking route', async () => {
    const trainer = await createTrainerWithToken();
    const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima' });
    const challenge = await prisma.challenge.create({
      data: {
        trainerId: trainer.trainerId,
        name: 'Datas',
        startDate: civilDate(utcDay(-1)),
        endDate: civilDate(utcDay(10)),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        participants: { create: [{ studentId: ana.id }] },
      },
    });
    const now = new Date();
    await prisma.pointTransaction.createMany({
      data: [
        { studentId: ana.id, trainerId: trainer.trainerId, challengeId: challenge.id, action: PointAction.WORKOUT_COMPLETED, points: 10, createdAt: now },
        { studentId: ana.id, trainerId: trainer.trainerId, challengeId: challenge.id, action: PointAction.TRAINER_BONUS, points: 30, createdAt: now },
      ],
    });

    const res = await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/ranking`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { studentId: ana.id, points: 40, workouts: 1, bonusPoints: 30, pointsThisWeek: 40, streakDays: 1 },
    ]);
  });
});

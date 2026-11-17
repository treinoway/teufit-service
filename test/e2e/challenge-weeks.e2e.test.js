import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { signupVerified } from '../helpers/signup-user.js';
import { closeDueChallenges } from '../../src/services/challenge-close-service.js';
import { computeChallengeStandings } from '../../src/services/challenge-consistency-service.js';
import { closeDueWeeks } from '../../src/services/consistency-close-service.js';
import { updateConfig } from '../../src/services/consistency-config-service.js';
import { weekStartFor } from '../../src/helpers/consistency-week.js';
import {
  ChallengeFormat,
  ChallengeOwnerType,
  ChallengeParticipantMode,
  ChallengeStatus,
  ChallengeVisibility,
} from '../../src/constants/challenge.js';
import { DEFAULT_CONFIG, SeasonStatus, WeekStatus } from '../../src/constants/consistency-ranking.js';
import { TrainingCategory, TrainingStatus, WeekDays, WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const CONCURRENT_RUNS = 4;

// Midnight-UTC Date of the current Monday in the default trainer time zone
function currentMondayDate() {
  const { year, month, day } = weekStartFor(new Date(), DEFAULT_CONFIG.timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

// "YYYY-MM-DD" of a midnight-UTC Date
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Midnight-UTC Date of the Monday `offset` weeks from the current one
function mondayAt(offset) {
  return new Date(currentMondayDate().getTime() + offset * MS_PER_WEEK);
}

// "YYYY-MM-DD" of the Sunday ending the week of a Monday
function sundayOf(monday) {
  return dateKey(new Date(monday.getTime() + 6 * MS_PER_DAY));
}

// "YYYY-MM-DD" of today plus `days` in UTC
function utcDay(days) {
  const now = new Date();
  return dateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)));
}

let counter = 0;

e2eDescribe('challenge weeks', () => {
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

  async function createTrainer() {
    counter += 1;
    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `trainer+weeks+${Date.now()}-${counter}@example.com`, password: 'StrongPassw0rd!' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();
    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { userId, trainerId: trainer.id, token: becomeRes.json().token.accessToken };
  }

  async function createStudent(trainerId, { firstName = 'Student', lastName = 'Test', withProtocol = false, linked = true } = {}) {
    counter += 1;
    const since = new Date(mondayAt(-3).getTime() - MS_PER_DAY);
    const user = await prisma.user.create({
      data: { email: `e2e+weeks-student-${Date.now()}-${counter}@example.com`, roles: [], firstName, lastName },
    });
    if (linked) await prisma.trainerStudent.create({ data: { trainerId, studentId: user.id, createdAt: since } });
    if (!withProtocol) return { id: user.id, trainings: null };
    const protocol = await prisma.trainingProtocol.create({
      data: {
        trainerId,
        assigneeId: user.id,
        name: 'Protocol',
        status: TrainingStatus.ACTIVE,
        startDate: since,
        createdAt: since,
        trainings: {
          create: [
            { name: 'Strength', category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY, createdAt: since },
            { name: 'Functional', category: TrainingCategory.FUNCTIONAL, weekDay: WeekDays.WEDNESDAY, createdAt: since },
            { name: 'Cardio', category: TrainingCategory.CARDIO, weekDay: null, createdAt: since },
          ],
        },
      },
      include: { trainings: true },
    });
    const trainings = Object.fromEntries(protocol.trainings.map((training) => [training.category, training]));
    return { id: user.id, trainings };
  }

  function createSeason(trainerId) {
    return prisma.consistencySeason.create({
      data: { trainerId, number: 1, startWeek: mondayAt(-4), weeks: 12, status: SeasonStatus.ACTIVE },
    });
  }

  function storeResult({ trainerId, seasonId, studentId, monday, score, status = WeekStatus.VALID }) {
    return prisma.consistencyWeeklyResult.create({
      data: {
        trainerId,
        studentId,
        seasonId,
        weekStart: monday,
        status,
        score,
        pillars: {},
        weights: {},
        closedAt: new Date(monday.getTime() + 6 * MS_PER_DAY),
      },
    });
  }

  async function seedWeeklyChallenge(trainerId, { start, weeks, studentIds, minPodiumWeeks = 2, name = 'Seeded' }) {
    const joinedAt = new Date(start.getTime() - MS_PER_WEEK);
    return prisma.challenge.create({
      data: {
        trainerId,
        name,
        format: ChallengeFormat.WEEKS,
        weeks,
        minPodiumWeeks,
        startDate: start,
        endDate: new Date(start.getTime() + (weeks * 7 - 1) * MS_PER_DAY),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        createdAt: joinedAt,
        participants: { create: studentIds.map((studentId) => ({ studentId, createdAt: joinedAt })) },
      },
    });
  }

  function call(token, method, url, payload) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  function createWeekly(token, overrides = {}) {
    return call(token, 'POST', '/trainer/challenges', {
      name: 'Verão 2027',
      format: ChallengeFormat.WEEKS,
      startWeek: dateKey(mondayAt(1)),
      weeks: 8,
      participantMode: ChallengeParticipantMode.EXPLICIT,
      studentIds: [],
      ...overrides,
    });
  }

  function createLogger() {
    return { info: vi.fn(), error: vi.fn() };
  }

  async function closedChallenge() {
    const trainer = await createTrainer();
    const season = await createSeason(trainer.trainerId);
    const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima' });
    const bia = await createStudent(trainer.trainerId, { firstName: 'Bia', lastName: 'Costa' });
    const challenge = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(-2), weeks: 2, studentIds: [ana.id, bia.id] });
    const store = (studentId, monday, score) =>
      storeResult({ trainerId: trainer.trainerId, seasonId: season.id, studentId, monday, score });
    await store(ana.id, mondayAt(-2), 100);
    await store(ana.id, mondayAt(-1), 90);
    await store(bia.id, mondayAt(-2), 80);
    await store(bia.id, mondayAt(-1), 70);
    await prisma.consistencyWeekClose.create({
      data: { trainerId: trainer.trainerId, weekStart: mondayAt(-1), closedAt: new Date(), studentsCount: 2 },
    });
    return { trainer, season, ana, bia, challenge };
  }

  async function runningChallenge({ withPoints = false } = {}) {
    const trainer = await createTrainer();
    const season = await createSeason(trainer.trainerId);
    const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima', withProtocol: true });
    const bia = await createStudent(trainer.trainerId, { firstName: 'Bia', lastName: 'Costa', withProtocol: true });
    const challenge = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(-1), weeks: 4, studentIds: [ana.id, bia.id] });
    await storeResult({ trainerId: trainer.trainerId, seasonId: season.id, studentId: ana.id, monday: mondayAt(-1), score: 100 });
    if (withPoints) {
      await prisma.pointTransaction.createMany({
        data: [ana.id, bia.id].map((studentId) => ({
          studentId,
          trainerId: trainer.trainerId,
          challengeId: challenge.id,
          action: 'workout_completed',
          points: 10,
          createdAt: new Date(mondayAt(0).getTime() + 15 * 3600000),
        })),
      });
    }
    return { trainer, season, ana, bia, challenge };
  }

  describe('create', () => {
    it('CAMP-04 creates a weekly championship from Monday to the Sunday of the last week', async () => {
      const trainer = await createTrainer();
      const students = [];
      for (let i = 0; i < 3; i += 1) students.push(await createStudent(trainer.trainerId));
      const start = mondayAt(1);

      const res = await createWeekly(trainer.token, { studentIds: students.map((student) => student.id) });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        format: ChallengeFormat.WEEKS,
        ownerType: ChallengeOwnerType.TRAINER,
        visibility: ChallengeVisibility.FULL,
        startDate: dateKey(start),
        endDate: sundayOf(mondayAt(8)),
        weeks: 8,
        status: ChallengeStatus.SCHEDULED,
        participantCount: 3,
        trainerId: trainer.trainerId,
      });
      const detail = await call(trainer.token, 'GET', `/trainer/challenges/${body.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ format: ChallengeFormat.WEEKS, startDate: dateKey(start), endDate: sundayOf(mondayAt(8)) });
    });

    it('CAMP-05 rejects a name over 100 or a description over 280 with 400', async () => {
      const trainer = await createTrainer();

      const longName = await createWeekly(trainer.token, { name: 'x'.repeat(101) });
      const longDescription = await createWeekly(trainer.token, { description: 'x'.repeat(281) });
      const emptyName = await createWeekly(trainer.token, { name: '' });

      expect(longName.statusCode).toBe(400);
      expect(longDescription.statusCode).toBe(400);
      expect(emptyName.statusCode).toBe(400);
      expect(longDescription.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(await prisma.challenge.count()).toBe(0);
    });

    it('CAMP-08 answers 422 challenge.filter.empty when the filter matches nobody', async () => {
      const trainer = await createTrainer();
      await createStudent(trainer.trainerId);

      const res = await createWeekly(trainer.token, {
        participantMode: ChallengeParticipantMode.FILTER,
        filter: { city: 'Cidade Que Não Existe' },
        studentIds: undefined,
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().messageCode).toBe('challenge.filter.empty');
      expect(await prisma.challenge.count()).toBe(0);
    });

    it('CAMP-09 answers 400 challenge.participant.notTrainee for a student of another trainer', async () => {
      const trainer = await createTrainer();
      const other = await createTrainer();
      const foreign = await createStudent(other.trainerId);

      const res = await createWeekly(trainer.token, { studentIds: [foreign.id] });

      expect(res.statusCode).toBe(400);
      expect(res.json().messageCode).toBe('challenge.participant.notTrainee');
      expect(await prisma.challenge.count()).toBe(0);
    });

    it('CAMP-12 creates a dates championship when no weekly format is sent', async () => {
      const trainer = await createTrainer();

      const res = await call(trainer.token, 'POST', '/trainer/challenges', {
        name: 'Livre',
        startDate: utcDay(2),
        endDate: utcDay(10),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        studentIds: [],
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        format: ChallengeFormat.DATES,
        startDate: utcDay(2),
        endDate: utcDay(10),
        weeks: null,
        minPodiumWeeks: null,
      });
    });

    it('CAMP-60 stores owner type trainer, including existing championships', async () => {
      const trainer = await createTrainer();
      const created = await createWeekly(trainer.token);
      await prisma.$executeRaw`
        INSERT INTO challenges (id, trainer_id, name, start_date, end_date, participant_mode, updated_at)
        VALUES (gen_random_uuid(), ${trainer.trainerId}::uuid, 'Legacy', ${mondayAt(1)}, ${mondayAt(2)}, 'explicit', now())
      `;
      const legacy = await prisma.challenge.findFirst({ where: { name: 'Legacy' } });

      const legacyRes = await call(trainer.token, 'GET', `/trainer/challenges/${legacy.id}`);

      expect(created.json().ownerType).toBe(ChallengeOwnerType.TRAINER);
      expect(legacy.ownerType).toBe(ChallengeOwnerType.TRAINER);
      expect(legacy.format).toBe(ChallengeFormat.DATES);
      expect(legacyRes.json()).toMatchObject({ ownerType: ChallengeOwnerType.TRAINER, format: ChallengeFormat.DATES });
    });

    it('CAMP-61 ignores an owner type sent in the body', async () => {
      const trainer = await createTrainer();

      const res = await createWeekly(trainer.token, { ownerType: ChallengeOwnerType.PLATFORM });

      expect(res.statusCode).toBe(201);
      const stored = await prisma.challenge.findUnique({ where: { id: res.json().id } });
      expect(stored.ownerType).toBe(ChallengeOwnerType.TRAINER);
      expect(stored.trainerId).toBe(trainer.trainerId);
      expect(res.json().ownerType).toBe(ChallengeOwnerType.TRAINER);
    });
  });

  describe('participants', () => {
    it('CAMP-16 removes a participant from both rankings and keeps results and points', async () => {
      const { trainer, ana, bia, challenge } = await runningChallenge({ withPoints: true });
      const before = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();
      const listed = (body) => [...body.rows, ...body.entering].map((row) => row.studentId);
      expect(listed(before)).toEqual(expect.arrayContaining([ana.id, bia.id]));

      const res = await call(trainer.token, 'DELETE', `/trainer/challenges/${challenge.id}/participants/${ana.id}`);

      expect(res.statusCode).toBe(204);
      const consistency = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();
      const points = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/ranking`)).json();
      expect(listed(consistency)).not.toContain(ana.id);
      expect(points.map((entry) => entry.studentId)).toEqual([bia.id]);
      expect(await prisma.consistencyWeeklyResult.count({ where: { studentId: ana.id } })).toBe(1);
      expect(await prisma.pointTransaction.count({ where: { studentId: ana.id, challengeId: challenge.id } })).toBe(1);
    });

    it('CAMP-18 answers 409 when changing participants of a closed or cancelled championship', async () => {
      const { trainer, ana, challenge } = await closedChallenge();
      await closeDueChallenges(prisma, createLogger());
      const extra = await createStudent(trainer.trainerId);
      const cancelled = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(1), weeks: 2, studentIds: [ana.id] });
      await prisma.challenge.update({ where: { id: cancelled.id }, data: { cancelledAt: new Date() } });

      const responses = [];
      for (const id of [challenge.id, cancelled.id]) {
        responses.push(await call(trainer.token, 'POST', `/trainer/challenges/${id}/participants`, { studentIds: [extra.id] }));
        responses.push(await call(trainer.token, 'DELETE', `/trainer/challenges/${id}/participants/${ana.id}`));
      }

      expect(responses.map((res) => res.statusCode)).toEqual([409, 409, 409, 409]);
      expect(await prisma.challengeParticipant.count({ where: { challengeId: challenge.id } })).toBe(2);
      expect(await prisma.challengeParticipant.count({ where: { challengeId: cancelled.id } })).toBe(1);
    });
  });

  describe('standings', () => {
    it('CAMP-28 reflects a completed workout on the next read of every running championship', async () => {
      const { trainer, ana, challenge } = await runningChallenge();
      const second = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(0), weeks: 2, studentIds: [ana.id], name: 'Second' });
      const scoreIn = async (id) => {
        const body = (await call(trainer.token, 'GET', `/trainer/challenges/${id}/consistency`)).json();
        return [...body.rows, ...body.entering].find((row) => row.studentId === ana.id).currentWeekScore;
      };
      const before = [await scoreIn(challenge.id), await scoreIn(second.id)];

      await prisma.workoutSession.create({
        data: {
          trainingId: ana.trainings[TrainingCategory.STRENGTH].id,
          userId: ana.id,
          status: WorkoutSessionStatus.COMPLETED,
          finishedAt: new Date(mondayAt(0).getTime() + 15 * 3600000),
        },
      });
      const after = [await scoreIn(challenge.id), await scoreIn(second.id)];

      expect(before[0]).toBe(before[1]);
      expect(after[0]).toBe(after[1]);
      expect(after[0]).toBeGreaterThan(before[0]);
    });

    it('CAMP-71 awards the XP of a completed workout in a weekly championship', async () => {
      const trainer = await createTrainer();
      const signupRes = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email: `e2e+weeks-xp-${Date.now()}@example.com`, password: 'StrongPassw0rd!' },
      });
      const { user: { id: studentId }, token: { accessToken: studentToken } } = signupRes.json();
      await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId } });
      const protocol = await prisma.trainingProtocol.create({
        data: {
          trainerId: trainer.trainerId,
          assigneeId: studentId,
          name: 'Protocol',
          status: TrainingStatus.ACTIVE,
          startDate: mondayAt(-1),
          trainings: { create: [{ name: 'Strength', category: TrainingCategory.STRENGTH, weekDay: WeekDays.MONDAY }] },
        },
        include: { trainings: true },
      });
      const created = await createWeekly(trainer.token, {
        startWeek: dateKey(mondayAt(0)),
        weeks: 2,
        studentIds: [studentId],
        ptsWorkoutCompleted: 25,
      });
      expect(created.json()).toMatchObject({ format: ChallengeFormat.WEEKS, status: ChallengeStatus.ACTIVE });
      const challengeId = created.json().id;

      const started = await call(studentToken, 'POST', `/my/trainings/${protocol.trainings[0].id}/workout-sessions`, {});
      expect(started.statusCode).toBe(201);
      const finished = await call(studentToken, 'PATCH', `/my/workout-sessions/${started.json().id}`, { status: WorkoutSessionStatus.COMPLETED });
      expect(finished.statusCode).toBe(200);
      await vi.waitFor(async () => {
        expect(await prisma.pointTransaction.count({ where: { challengeId, studentId } })).toBe(1);
      });

      const ranking = (await call(trainer.token, 'GET', `/trainer/challenges/${challengeId}/ranking`)).json();
      const mine = (await call(studentToken, 'GET', `/my/challenges/${challengeId}/ranking`)).json();
      const myChallenges = (await call(studentToken, 'GET', '/my/challenges')).json();
      expect(ranking).toEqual([expect.objectContaining({ studentId, points: 25 })]);
      expect(mine).toMatchObject({ myPosition: 1, myPoints: 25 });
      expect(myChallenges).toEqual([expect.objectContaining({ id: challengeId, format: ChallengeFormat.WEEKS, status: ChallengeStatus.ACTIVE })]);
    });

    it('CAMP-68 applies a new time zone from the next week', async () => {
      const trainer = await createTrainer();
      const challenge = await seedWeeklyChallenge(trainer.trainerId, {
        start: new Date('2026-11-09T00:00:00.000Z'),
        weeks: 4,
        studentIds: [],
      });
      const wednesdayOfWeek2 = new Date('2026-11-18T15:00:00.000Z');
      const wednesdayOfWeek3 = new Date('2026-11-25T15:00:00.000Z');

      await updateConfig(prisma, trainer.trainerId, { timeZone: 'Asia/Tokyo' }, wednesdayOfWeek2);
      const thisWeek = await computeChallengeStandings(prisma, challenge, wednesdayOfWeek2);
      const nextWeek = await computeChallengeStandings(prisma, challenge, wednesdayOfWeek3);

      expect(thisWeek.currentWeek).toBe(2);
      expect(thisWeek.closesAt).toEqual(new Date('2026-11-23T00:00:00.000Z'));
      expect(nextWeek.currentWeek).toBe(3);
      expect(nextWeek.closesAt).toEqual(new Date('2026-11-29T12:00:00.000Z'));
    });

    it('CAMP-29 returns the row fields', async () => {
      const { trainer, ana, bia, challenge } = await runningChallenge();

      const res = await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe(ChallengeStatus.ACTIVE);
      expect(body.currentWeek).toBe(2);
      expect(body.closesAt).toEqual(expect.any(String));
      expect(body.challenge).toMatchObject({ id: challenge.id, weeks: 4, minPodiumWeeks: 2, participantCount: 2 });
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({
        studentId: ana.id,
        name: 'Ana Lima',
        position: 1,
        eligible: true,
        faixa: 'full',
        average: 100,
        validWeeks: 2,
        weeks100: 1,
        streak: 1,
        currentWeekScore: expect.any(Number),
        weekStatus: WeekStatus.VALID,
        entering: null,
      });
      expect(body.entering).toHaveLength(1);
      expect(body.entering[0]).toMatchObject({
        studentId: bia.id,
        name: 'Bia Costa',
        position: null,
        eligible: false,
        faixa: 'entering',
        validWeeks: 1,
        currentWeekScore: expect.any(Number),
        entering: { validWeeks: 1, required: 2 },
        weeksMissing: 1,
      });
    });
  });

  describe('close', () => {
    it('CAMP-32 freezes the final standings after the last week closes', async () => {
      const { trainer, ana, bia, challenge } = await closedChallenge();
      const logger = createLogger();

      await closeDueChallenges(prisma, logger);

      const stored = await prisma.challenge.findUnique({ where: { id: challenge.id } });
      expect(stored.closedAt).not.toBeNull();
      const standings = await prisma.challengeConsistencyStanding.findMany({ where: { challengeId: challenge.id }, orderBy: { position: 'asc' } });
      expect(standings.map((row) => [row.studentId, row.position, Number(row.average), row.validWeeks, row.weeks100, row.eligible])).toEqual([
        [ana.id, 1, 95, 2, 1, true],
        [bia.id, 2, 75, 2, 0, true],
      ]);
      const detail = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}`)).json();
      expect(detail.status).toBe(ChallengeStatus.COMPLETED);
      const consistency = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();
      expect(consistency.status).toBe(ChallengeStatus.COMPLETED);
      expect(consistency.rows.map((row) => [row.studentId, row.position, row.average])).toEqual([[ana.id, 1, 95], [bia.id, 2, 75]]);
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ challengeId: challenge.id, ranked: 2 }), expect.any(String));
    });

    it('CAMP-33 closing twice keeps one row per participant', async () => {
      const { challenge } = await closedChallenge();

      await closeDueChallenges(prisma, createLogger());
      const first = await prisma.challengeConsistencyStanding.findMany({ where: { challengeId: challenge.id }, orderBy: { studentId: 'asc' } });
      await closeDueChallenges(prisma, createLogger());
      await prisma.challenge.update({ where: { id: challenge.id }, data: { closedAt: null } });
      await closeDueChallenges(prisma, createLogger());

      const final = await prisma.challengeConsistencyStanding.findMany({ where: { challengeId: challenge.id }, orderBy: { studentId: 'asc' } });
      expect(final).toHaveLength(2);
      expect(final.map((row) => [row.id, row.position, Number(row.average)])).toEqual(
        first.map((row) => [row.id, row.position, Number(row.average)]),
      );
    });

    it('CAMP-34 closes each championship once across concurrent runs', async () => {
      const { challenge } = await closedChallenge();
      const loggers = Array.from({ length: CONCURRENT_RUNS }, createLogger);

      await Promise.all(loggers.map((logger) => closeDueChallenges(prisma, logger)));

      expect(await prisma.challengeConsistencyStanding.count({ where: { challengeId: challenge.id } })).toBe(2);
      const closeLogs = loggers.flatMap((logger) => logger.info.mock.calls).filter(([fields]) => fields.challengeId === challenge.id);
      expect(closeLogs).toHaveLength(1);
      expect(loggers.flatMap((logger) => logger.error.mock.calls)).toEqual([]);
    });

    it('CAMP-72 counts both closed weeks in the final standings of a championship run without an active season', async () => {
      const trainer = await createTrainer();
      const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima', withProtocol: true });
      const bia = await createStudent(trainer.trainerId, { firstName: 'Bia', lastName: 'Costa', withProtocol: true });
      const carl = await createStudent(trainer.trainerId, { firstName: 'Carl', lastName: 'Reis', withProtocol: true });
      const challenge = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(-2), weeks: 2, studentIds: [ana.id, bia.id] });
      const complete = (student, monday, category) =>
        prisma.workoutSession.create({
          data: {
            trainingId: student.trainings[category].id,
            userId: student.id,
            status: WorkoutSessionStatus.COMPLETED,
            finishedAt: new Date(monday.getTime() + 15 * 3600000),
          },
        });
      for (const category of [TrainingCategory.STRENGTH, TrainingCategory.FUNCTIONAL, TrainingCategory.CARDIO]) {
        await complete(ana, mondayAt(-2), category);
        await complete(carl, mondayAt(-2), category);
      }
      await complete(ana, mondayAt(-1), TrainingCategory.STRENGTH);
      await complete(bia, mondayAt(-1), TrainingCategory.STRENGTH);
      await complete(bia, mondayAt(-1), TrainingCategory.CARDIO);
      const afterFirstWeek = new Date(mondayAt(-1).getTime() + 15 * 3600000);
      const runJob = async (now) => {
        await closeDueWeeks(prisma, createLogger(), now);
        await closeDueChallenges(prisma, createLogger(), now);
      };

      await runJob(afterFirstWeek);
      expect((await prisma.challenge.findUnique({ where: { id: challenge.id } })).closedAt).toBeNull();
      await runJob(new Date());

      const results = await prisma.consistencyWeeklyResult.findMany({ where: { trainerId: trainer.trainerId }, orderBy: { weekStart: 'asc' } });
      expect(await prisma.consistencySeason.count({ where: { trainerId: trainer.trainerId } })).toBe(0);
      expect(results.every((row) => row.seasonId === null && row.status === WeekStatus.VALID)).toBe(true);
      expect(results.map((row) => [row.studentId, dateKey(row.weekStart)]).sort()).toEqual(
        [[ana.id, dateKey(mondayAt(-2))], [ana.id, dateKey(mondayAt(-1))], [bia.id, dateKey(mondayAt(-2))], [bia.id, dateKey(mondayAt(-1))]].sort(),
      );
      const meanOf = (studentId) => {
        const scores = results.filter((row) => row.studentId === studentId).map((row) => Number(row.score));
        return Math.round(((scores[0] + scores[1]) / 2) * 10000) / 10000;
      };
      expect((await prisma.challenge.findUnique({ where: { id: challenge.id } })).closedAt).not.toBeNull();
      const standings = await prisma.challengeConsistencyStanding.findMany({ where: { challengeId: challenge.id }, orderBy: { position: 'asc' } });
      expect(standings.map((row) => [row.studentId, row.position, Number(row.average), row.validWeeks, row.eligible])).toEqual([
        [ana.id, 1, meanOf(ana.id), 2, true],
        [bia.id, 2, meanOf(bia.id), 2, true],
      ]);
      expect(meanOf(ana.id)).toBeGreaterThan(meanOf(bia.id));
    });

    it('CAMP-37 keeps the final standings after later workouts and changes', async () => {
      const { trainer, season, ana, challenge } = await closedChallenge();
      await closeDueChallenges(prisma, createLogger());
      const before = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();

      await prisma.consistencyWeeklyResult.updateMany({ where: { studentId: ana.id, weekStart: mondayAt(-1) }, data: { score: 10 } });
      await storeResult({ trainerId: trainer.trainerId, seasonId: season.id, studentId: ana.id, monday: mondayAt(0), score: 20 });
      await prisma.trainerStudent.updateMany({ where: { studentId: ana.id }, data: { activeOnPlan: false } });
      await prisma.challengeParticipant.deleteMany({ where: { challengeId: challenge.id, studentId: ana.id } });
      await prisma.challenge.update({ where: { id: challenge.id }, data: { minPodiumWeeks: 1 } });
      await closeDueChallenges(prisma, createLogger());

      const after = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();
      expect(after.rows).toEqual(before.rows);
      expect(after.entering).toEqual(before.entering);
      expect(after.rows.map((row) => [row.studentId, row.average])).toEqual([[ana.id, 95], [expect.any(String), 75]]);
    });
  });

  describe('edit', () => {
    it('CAMP-39 edits every field of a scheduled weekly championship', async () => {
      const trainer = await createTrainer();
      const created = (await createWeekly(trainer.token, { weeks: 4, minPodiumWeeks: 2 })).json();

      const res = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, {
        name: 'Novo nome',
        description: 'Prêmio: camiseta',
        startWeek: dateKey(mondayAt(2)),
        weeks: 3,
        minPodiumWeeks: 3,
        anonymousRanking: true,
        visibility: ChallengeVisibility.POSITION,
        ptsWorkoutCompleted: 20,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Novo nome',
        description: 'Prêmio: camiseta',
        startDate: dateKey(mondayAt(2)),
        endDate: sundayOf(mondayAt(4)),
        weeks: 3,
        minPodiumWeeks: 3,
        anonymousRanking: true,
        visibility: ChallengeVisibility.POSITION,
        ptsWorkoutCompleted: 20,
        status: ChallengeStatus.SCHEDULED,
      });
    });

    it('CAMP-11 makes the current week neutral when an edit moves the start into it after Monday 00:00', async () => {
      const trainer = await createTrainer();
      const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima', withProtocol: true });
      const scheduled = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(1), weeks: 2, studentIds: [ana.id], minPodiumWeeks: 1 });
      await prisma.challengeParticipant.updateMany({
        where: { challengeId: scheduled.id },
        data: { createdAt: new Date(mondayAt(-1).getTime() + MS_PER_DAY) },
      });

      const res = await call(trainer.token, 'PATCH', `/trainer/challenges/${scheduled.id}`, { startWeek: dateKey(mondayAt(0)) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ startDate: dateKey(mondayAt(0)), status: ChallengeStatus.ACTIVE });
      const consistency = (await call(trainer.token, 'GET', `/trainer/challenges/${scheduled.id}/consistency`)).json();
      expect(consistency).toMatchObject({ status: ChallengeStatus.ACTIVE, currentWeek: 1, rows: [], entering: [] });
    });

    it('CAMP-40 edits name, description, anonymous ranking and visibility while running', async () => {
      const trainer = await createTrainer();
      const created = (await createWeekly(trainer.token, { startWeek: dateKey(mondayAt(0)), weeks: 4 })).json();
      expect(created.status).toBe(ChallengeStatus.ACTIVE);

      const res = await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, {
        name: 'Em andamento',
        description: 'Nova descrição',
        anonymousRanking: true,
        visibility: ChallengeVisibility.OFF,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Em andamento',
        description: 'Nova descrição',
        anonymousRanking: true,
        visibility: ChallengeVisibility.OFF,
        status: ChallengeStatus.ACTIVE,
      });
    });

    it('CAMP-41 answers 409 for start, weeks, end, minimum or points while running', async () => {
      const trainer = await createTrainer();
      const created = (await createWeekly(trainer.token, { startWeek: dateKey(mondayAt(0)), weeks: 4 })).json();
      const before = await prisma.challenge.findUnique({ where: { id: created.id } });

      const changes = [
        { startWeek: dateKey(mondayAt(1)) },
        { weeks: 6 },
        { endDate: utcDay(60) },
        { minPodiumWeeks: 1 },
        { ptsWorkoutCompleted: 99 },
      ];
      const responses = [];
      for (const change of changes) responses.push(await call(trainer.token, 'PATCH', `/trainer/challenges/${created.id}`, change));

      expect(responses.map((res) => res.statusCode)).toEqual([409, 409, 409, 409, 409]);
      expect(responses.map((res) => res.json().messageCode)).toEqual(Array(5).fill('challenge.alreadyStarted'));
      const after = await prisma.challenge.findUnique({ where: { id: created.id } });
      expect(after).toEqual(before);
    });

    it('CAMP-42 schedules the close for this week and moves the end to its Sunday', async () => {
      const { trainer, challenge } = await runningChallenge();

      const res = await call(trainer.token, 'POST', `/trainer/challenges/${challenge.id}/close`);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: challenge.id,
        weeks: 2,
        endDate: sundayOf(mondayAt(0)),
        status: ChallengeStatus.ACTIVE,
        closeRequestedAt: expect.any(String),
        closesAt: expect.any(String),
      });
      const closesAt = new Date(body.closesAt);
      expect(closesAt.getTime()).toBeGreaterThan(mondayAt(0).getTime());
      expect(closesAt.getTime()).toBeLessThanOrEqual(mondayAt(1).getTime() + 3 * 3600000);
      const stored = await prisma.challenge.findUnique({ where: { id: challenge.id } });
      expect(stored.closedAt).toBeNull();
      expect(dateKey(stored.endDate)).toBe(sundayOf(mondayAt(0)));
    });

    it('CAMP-43 cancels without final standings and keeps results and points', async () => {
      const { trainer, ana, challenge } = await runningChallenge({ withPoints: true });

      const res = await call(trainer.token, 'POST', `/trainer/challenges/${challenge.id}/cancel`);
      await closeDueChallenges(prisma, createLogger());

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(ChallengeStatus.CANCELLED);
      expect(await prisma.challengeConsistencyStanding.count({ where: { challengeId: challenge.id } })).toBe(0);
      expect(await prisma.consistencyWeeklyResult.count({ where: { studentId: ana.id } })).toBe(1);
      expect(await prisma.pointTransaction.count({ where: { challengeId: challenge.id } })).toBe(2);
      const consistency = (await call(trainer.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`)).json();
      expect(consistency).toMatchObject({ status: ChallengeStatus.CANCELLED, rows: [], entering: [] });
    });

    it('CAMP-44 deletes a scheduled weekly championship', async () => {
      const trainer = await createTrainer();
      const created = (await createWeekly(trainer.token)).json();

      const res = await call(trainer.token, 'DELETE', `/trainer/challenges/${created.id}`);

      expect(res.statusCode).toBe(204);
      expect(await prisma.challenge.findUnique({ where: { id: created.id } })).toBeNull();
    });

    it('CAMP-45 answers 409 to edit, close or cancel an ended or cancelled championship', async () => {
      const { trainer, ana, challenge } = await closedChallenge();
      await closeDueChallenges(prisma, createLogger());
      const cancelled = await seedWeeklyChallenge(trainer.trainerId, { start: mondayAt(0), weeks: 2, studentIds: [ana.id] });
      await prisma.challenge.update({ where: { id: cancelled.id }, data: { cancelledAt: new Date() } });
      const snapshot = async () => prisma.challenge.findMany({ orderBy: { id: 'asc' } });
      const before = await snapshot();

      const statuses = [];
      for (const id of [challenge.id, cancelled.id]) {
        statuses.push((await call(trainer.token, 'PATCH', `/trainer/challenges/${id}`, { name: 'Outro' })).statusCode);
        statuses.push((await call(trainer.token, 'POST', `/trainer/challenges/${id}/close`)).statusCode);
        statuses.push((await call(trainer.token, 'POST', `/trainer/challenges/${id}/cancel`)).statusCode);
      }

      expect(statuses).toEqual([409, 409, 409, 409, 409, 409]);
      expect(await snapshot()).toEqual(before);
    });

    it('CAMP-47 still moves the end of a running dates championship', async () => {
      const trainer = await createTrainer();
      const running = await prisma.challenge.create({
        data: {
          trainerId: trainer.trainerId,
          name: 'Livre',
          startDate: new Date(`${utcDay(-3)}T12:00:00.000Z`),
          endDate: new Date(`${utcDay(5)}T12:00:00.000Z`),
          participantMode: ChallengeParticipantMode.EXPLICIT,
        },
      });

      const res = await call(trainer.token, 'PATCH', `/trainer/challenges/${running.id}`, { endDate: utcDay(12) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ format: ChallengeFormat.DATES, status: ChallengeStatus.ACTIVE, endDate: utcDay(12) });
    });
  });

  describe('access', () => {
    it('CAMP-65 answers 403 to another trainer', async () => {
      const { challenge } = await runningChallenge();
      const other = await createTrainer();

      const consistency = await call(other.token, 'GET', `/trainer/challenges/${challenge.id}/consistency`);
      const close = await call(other.token, 'POST', `/trainer/challenges/${challenge.id}/close`);

      expect(consistency.statusCode).toBe(403);
      expect(consistency.json().messageCode).toBe('challenge.forbidden.notOwner');
      expect(close.statusCode).toBe(403);
      expect(close.json().messageCode).toBe('challenge.forbidden.notOwner');
      expect((await prisma.challenge.findUnique({ where: { id: challenge.id } })).closeRequestedAt).toBeNull();
    });

    it('CAMP-66 answers 409 challenge.notWeekly for a dates championship', async () => {
      const trainer = await createTrainer();
      const created = await call(trainer.token, 'POST', '/trainer/challenges', {
        name: 'Livre',
        startDate: utcDay(2),
        endDate: utcDay(10),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        studentIds: [],
      });

      const res = await call(trainer.token, 'GET', `/trainer/challenges/${created.json().id}/consistency`);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CHALLENGE_NOT_WEEKLY', messageCode: 'challenge.notWeekly' });
    });
  });
});

import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { signupVerified } from '../helpers/signup-user.js';
import { weekStartFor } from '../../src/helpers/consistency-week.js';
import {
  ChallengeErrorCode,
  ChallengeFormat,
  ChallengeMessageCode,
  ChallengeParticipantMode,
  ChallengeStatus,
  ChallengeVisibility,
} from '../../src/constants/challenge.js';
import {
  ANONYMOUS_DISPLAY_NAME,
  AppearAs,
  CONSISTENCY_PRIVACY_TERM_VERSION,
  DEFAULT_CONFIG,
  Faixa,
  StudentOverviewState,
  WeekStatus,
} from '../../src/constants/consistency-ranking.js';
import { GamificationErrorCode, GamificationMessageCode, PointAction } from '../../src/constants/gamification.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const PEER_KEYS = ['key', 'displayName', 'initials', 'avatarUrl', 'position', 'average', 'faixa', 'streak', 'isMe'];
const FORBIDDEN_KEYS = ['studentId', 'id', 'email', 'phone', 'pillars', 'name', 'userId', 'firstName', 'lastName', 'birthDate'];

// Midnight-UTC Date of the Monday `offset` weeks from the current one, in the default trainer time zone
function mondayAt(offset) {
  const { year, month, day } = weekStartFor(new Date(), DEFAULT_CONFIG.timeZone);
  return new Date(Date.UTC(year, month - 1, day) + offset * MS_PER_WEEK);
}

let counter = 0;

e2eDescribe('my consistency ranking', () => {
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
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `trainer+my-consistency+${Date.now()}-${counter}@example.com`, password: 'StrongPassw0rd!' },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();
    const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${accessToken}` } });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
  }

  async function createStudent(trainerId, { firstName, lastName }) {
    counter += 1;
    const user = await prisma.user.create({
      data: { email: `e2e+my-consistency-${Date.now()}-${counter}@example.com`, roles: [], firstName, lastName },
    });
    await prisma.trainerStudent.create({ data: { trainerId, studentId: user.id, createdAt: new Date(mondayAt(-3).getTime() - MS_PER_DAY) } });
    const token = app.jwt.sign({ sub: user.id, email: user.email, roles: user.roles, status: user.status });
    return { ...user, token };
  }

  function seedWeekly(trainerId, { name, start, weeks, studentIds, cancelledAt = null }) {
    const joinedAt = new Date(start.getTime() - MS_PER_WEEK);
    return prisma.challenge.create({
      data: {
        trainerId,
        name,
        format: ChallengeFormat.WEEKS,
        weeks,
        minPodiumWeeks: 2,
        startDate: start,
        endDate: new Date(start.getTime() + (weeks * 7 - 1) * MS_PER_DAY),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        cancelledAt,
        createdAt: joinedAt,
        participants: { create: studentIds.map((studentId) => ({ studentId, createdAt: joinedAt })) },
      },
    });
  }

  function seedDates(trainerId, { name, studentIds }) {
    return prisma.challenge.create({
      data: {
        trainerId,
        name,
        format: ChallengeFormat.DATES,
        startDate: mondayAt(-1),
        endDate: new Date(mondayAt(2).getTime() - MS_PER_DAY),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        participants: { create: studentIds.map((studentId) => ({ studentId })) },
      },
    });
  }

  function storeResult(trainerId, studentId, monday, score) {
    return prisma.consistencyWeeklyResult.create({
      data: {
        trainerId,
        studentId,
        weekStart: monday,
        status: WeekStatus.VALID,
        score,
        pillars: {},
        weights: {},
        closedAt: new Date(monday.getTime() + 6 * MS_PER_DAY),
      },
    });
  }

  function call(token, method, url, payload) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  function choose(student, appearAs) {
    return call(student.token, 'PUT', '/my/consistency-ranking/privacy', { appearAs, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION });
  }

  async function seedTeam() {
    const trainer = await createTrainer();
    const ana = await createStudent(trainer.trainerId, { firstName: 'Ana', lastName: 'Lima' });
    const bruno = await createStudent(trainer.trainerId, { firstName: 'Bruno', lastName: 'Costa' });
    const camila = await createStudent(trainer.trainerId, { firstName: 'Camila', lastName: 'Rocha' });
    const davi = await createStudent(trainer.trainerId, { firstName: 'Davi', lastName: 'Souza' });
    const eva = await createStudent(trainer.trainerId, { firstName: 'Eva', lastName: 'Melo' });
    const fabio = await createStudent(trainer.trainerId, { firstName: 'Fabio', lastName: 'Nunes' });
    const team = [ana, bruno, camila, davi, eva, fabio];
    const ids = team.map((student) => student.id);
    const verao = await seedWeekly(trainer.trainerId, { name: 'Verão 2027', start: mondayAt(-2), weeks: 4, studentIds: ids });
    const turma = await seedWeekly(trainer.trainerId, { name: 'Turma da manhã', start: mondayAt(-2), weeks: 6, studentIds: [ana.id, camila.id] });
    const cancelled = await seedWeekly(trainer.trainerId, { name: 'Cancelado', start: mondayAt(-2), weeks: 4, studentIds: [camila.id], cancelledAt: new Date() });
    const outside = await seedWeekly(trainer.trainerId, { name: 'Sem a Camila', start: mondayAt(-2), weeks: 4, studentIds: [ana.id] });
    const dates = await seedDates(trainer.trainerId, { name: 'Datas livres', studentIds: [camila.id] });
    const scores = [[ana, 100], [bruno, 90], [camila, 80], [davi, 70], [eva, 60]];
    for (const [student, score] of scores) {
      await storeResult(trainer.trainerId, student.id, mondayAt(-2), score);
      await storeResult(trainer.trainerId, student.id, mondayAt(-1), score);
    }
    await storeResult(trainer.trainerId, fabio.id, mondayAt(-1), 50);
    return { trainer, ana, bruno, camila, davi, eva, fabio, team, verao, turma, cancelled, outside, dates };
  }

  function peerRowsOf(board) {
    return [
      ...(board.podium ?? []),
      ...(board.club100?.members ?? []),
      ...board.neighbors,
      ...board.entering,
      ...board.items,
    ];
  }

  it('APP-39 serves overview, championship standings and privacy to the student', async () => {
    const { ana, camila, verao, turma, cancelled, dates } = await seedTeam();
    await choose(ana, AppearAs.NAME);

    const before = await call(camila.token, 'GET', '/my/consistency-ranking');
    const chosen = await choose(camila, AppearAs.NAME);
    const after = await call(camila.token, 'GET', '/my/consistency-ranking');
    const board = await call(camila.token, 'GET', `/my/challenges/${verao.id}/consistency`);
    const weekly = await call(camila.token, 'GET', `/my/challenges?format=${ChallengeFormat.WEEKS}`);
    const all = await call(camila.token, 'GET', '/my/challenges');

    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      state: StudentOverviewState.OK,
      week: { closesAt: expect.any(String), pillars: expect.any(Array) },
      highlight: { challengeId: verao.id, name: 'Verão 2027', visibility: ChallengeVisibility.FULL, position: 3, total: 5, faixa: Faixa.STEADY, average: 80 },
      othersCount: 1,
      privacy: { appearAs: AppearAs.PENDING, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: null },
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toEqual({ appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: expect.any(String) });
    expect(after.json().privacy).toMatchObject({ appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION });

    expect(board.statusCode).toBe(200);
    const body = board.json();
    expect(body.challenge).toMatchObject({ id: verao.id, name: 'Verão 2027', status: ChallengeStatus.ACTIVE, weeks: 4, currentWeek: 3, participantCount: 6 });
    expect(body).toMatchObject({ visibility: ChallengeVisibility.FULL, closesAt: expect.any(String), privacy: { appearAs: AppearAs.NAME } });
    expect(body.me).toMatchObject({ appearsAs: 'Camila R.', position: 3, total: 5, faixa: Faixa.STEADY, average: 80, weeks100: { done: 0, of: 2 } });
    expect(body.me.weekStrip.map((week) => week.week)).toEqual([1, 2, 3, 4]);
    expect(body.board.podium.map((row) => [row.displayName, row.position])).toEqual([
      ['Ana L.', 1],
      [ANONYMOUS_DISPLAY_NAME, 2],
      ['Camila R.', 3],
    ]);
    expect(body.board.neighbors.map((row) => [row.position, row.isMe])).toEqual([[1, false], [2, false], [3, true], [4, false], [5, false]]);
    expect(body.board.entering).toEqual([expect.objectContaining({ displayName: ANONYMOUS_DISPLAY_NAME, validWeeks: 1, required: 2, weeksMissing: 1 })]);
    expect(body.board).toMatchObject({ total: 5, page: 1, pageSize: 20, totalPages: 1 });
    expect(body.board.items).toHaveLength(5);

    expect(weekly.statusCode).toBe(200);
    expect(weekly.json().map((item) => item.id)).toEqual([verao.id, turma.id]);
    expect(weekly.json()[0]).toMatchObject({
      name: 'Verão 2027',
      format: ChallengeFormat.WEEKS,
      status: ChallengeStatus.ACTIVE,
      participantCount: 6,
      consistency: { visibility: ChallengeVisibility.FULL, position: 3, total: 5, faixa: Faixa.STEADY, average: 80 },
    });
    const allIds = all.json().map((item) => item.id);
    expect(allIds).toEqual(expect.arrayContaining([verao.id, turma.id, dates.id]));
    expect(allIds).not.toContain(cancelled.id);
    expect(all.json().find((item) => item.id === dates.id)).toMatchObject({ format: ChallengeFormat.DATES, consistency: null });
  });

  it('APP-41 never returns email, phone, internal id or another student pillars', async () => {
    const { trainer, ana, camila, team, verao } = await seedTeam();
    await choose(ana, AppearAs.NAME);

    const board = await call(camila.token, 'GET', `/my/challenges/${verao.id}/consistency`);
    const overview = await call(camila.token, 'GET', '/my/consistency-ranking');
    const list = await call(camila.token, 'GET', `/my/challenges?format=${ChallengeFormat.WEEKS}`);

    expect(board.statusCode).toBe(200);
    const body = board.json();
    const rows = peerRowsOf(body.board);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const field of Object.keys(row)) expect([...PEER_KEYS, 'shared', 'validWeeks', 'required', 'weeksMissing']).toContain(field);
      for (const field of FORBIDDEN_KEYS) expect(row).not.toHaveProperty(field);
    }
    expect(Object.keys(body.me)).not.toEqual(expect.arrayContaining(['studentId', 'email']));
    const others = team.filter((student) => student.id !== camila.id);
    for (const text of [JSON.stringify(body), overview.body, list.body]) {
      for (const student of others) {
        expect(text).not.toContain(student.id);
        expect(text).not.toContain(student.email);
      }
      expect(text).not.toContain(trainer.userId);
    }
    expect(body.board.items.find((row) => row.position === 1)).toMatchObject({ displayName: 'Ana L.', isMe: false });
    expect(body.board.items.find((row) => row.position === 4)).toMatchObject({ displayName: ANONYMOUS_DISPLAY_NAME, avatarUrl: null, initials: '' });
  });

  it('APP-43 keeps /my/ranking at 410 and /my/points as today', async () => {
    const { trainer, camila, verao } = await seedTeam();
    await prisma.pointTransaction.create({
      data: { studentId: camila.id, trainerId: trainer.trainerId, challengeId: verao.id, action: PointAction.WORKOUT_COMPLETED, points: 10 },
    });

    const ranking = await call(camila.token, 'GET', '/my/ranking');
    const points = await call(camila.token, 'GET', `/my/points?challengeId=${verao.id}`);
    const summary = await call(camila.token, 'GET', `/my/points/summary?challengeId=${verao.id}`);

    expect(ranking.statusCode).toBe(410);
    expect(ranking.json()).toMatchObject({
      error: GamificationErrorCode.GLOBAL_RANKING_REMOVED,
      messageCode: GamificationMessageCode.GLOBAL_RANKING_REMOVED,
      message: expect.any(String),
    });
    expect(points.statusCode).toBe(200);
    expect(points.json()).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(points.json().data).toEqual([expect.objectContaining({ action: PointAction.WORKOUT_COMPLETED, points: 10 })]);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ totalPoints: 10, breakdown: { [PointAction.WORKOUT_COMPLETED]: 10 } });
  });

  it('APP-60 answers 404 for a championship the student is not in or a cancelled one', async () => {
    const { camila, cancelled, outside } = await seedTeam();

    const notIn = await call(camila.token, 'GET', `/my/challenges/${outside.id}/consistency`);
    const gone = await call(camila.token, 'GET', `/my/challenges/${cancelled.id}/consistency`);

    for (const response of [notIn, gone]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
        messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
        message: expect.any(String),
      });
    }
  });

  it('APP-61 applies the championship visibility on the server', async () => {
    const { trainer, camila, verao, turma } = await seedTeam();

    const toPosition = await call(trainer.token, 'PATCH', `/trainer/challenges/${verao.id}`, { visibility: ChallengeVisibility.POSITION });
    const positionOnly = (await call(camila.token, 'GET', `/my/challenges/${verao.id}/consistency`)).json();
    const positionOverview = (await call(camila.token, 'GET', '/my/consistency-ranking')).json();
    const toOff = await call(trainer.token, 'PATCH', `/trainer/challenges/${verao.id}`, { visibility: ChallengeVisibility.OFF });
    const off = (await call(camila.token, 'GET', `/my/challenges/${verao.id}/consistency`)).json();
    const offOverview = (await call(camila.token, 'GET', '/my/consistency-ranking')).json();
    const offList = (await call(camila.token, 'GET', `/my/challenges?format=${ChallengeFormat.WEEKS}`)).json();
    const other = (await call(camila.token, 'GET', `/my/challenges/${turma.id}/consistency`)).json();

    expect(toPosition.statusCode).toBe(200);
    expect(toPosition.json().visibility).toBe(ChallengeVisibility.POSITION);
    expect(positionOnly).toMatchObject({ visibility: ChallengeVisibility.POSITION, board: null, me: { position: 3, total: 5, faixa: Faixa.STEADY, average: null } });
    expect(positionOverview.highlight).toMatchObject({ visibility: ChallengeVisibility.POSITION, position: 3, total: 5, faixa: Faixa.STEADY, average: null });

    expect(toOff.statusCode).toBe(200);
    expect(off).toMatchObject({ visibility: ChallengeVisibility.OFF, board: null, me: { position: null, total: null, faixa: null, average: null } });
    expect(offOverview.highlight).toMatchObject({ visibility: ChallengeVisibility.OFF, position: null, total: null, faixa: null, average: null });
    expect(offOverview.week).toMatchObject({ closesAt: expect.any(String) });
    expect(offList.find((item) => item.id === verao.id).consistency).toEqual({
      visibility: ChallengeVisibility.OFF, position: null, total: null, faixa: null, average: null,
    });

    expect(other).toMatchObject({ visibility: ChallengeVisibility.FULL, me: { position: 2 } });
    expect(other.board.items.length).toBe(2);
  });

  it('APP-36 returns the privacy counts to the trainer', async () => {
    const { trainer, ana, bruno, verao } = await seedTeam();
    await choose(ana, AppearAs.NAME);
    await choose(bruno, AppearAs.ANONYMOUS);

    const response = await call(trainer.token, 'GET', `/trainer/challenges/${verao.id}/consistency`);

    expect(response.statusCode).toBe(200);
    expect(response.json().privacyCounts).toEqual({ name: 1, anonymous: 1, pending: 4 });
  });
});

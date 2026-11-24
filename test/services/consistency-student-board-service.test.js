import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStudentBoard } from '../../src/services/consistency-student-board-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { ChallengeErrorCode, ChallengeMessageCode, ChallengeStatus, ChallengeVisibility } from '../../src/constants/challenge.js';
import {
  AppearAs,
  CONSISTENCY_PRIVACY_TERM_VERSION,
  Faixa,
  WeekStatus,
  WeekStripStatus,
} from '../../src/constants/consistency-ranking.js';
import { countsFrom, createWorld, dateOnly, weeklyResult } from '../helpers/consistency-student-world.js';

vi.mock('../../src/services/consistency-target-service.js', async (importOriginal) => ({ ...(await importOriginal()), materializeTargets: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', async (importOriginal) => ({ ...(await importOriginal()), countDone: vi.fn() }));

const SP = 'America/Sao_Paulo';
const TRAINER = 'trainer-1';
// Wednesday 2026-11-25 12:00 in São Paulo; the running week starts Monday 2026-11-23 and closes Sunday 29 at 21:00 (trainer default)
const NOW = new Date('2026-11-25T15:00:00.000Z');
const OLD_LINK = new Date('2026-01-01T12:00:00.000Z');
const JOINED = new Date('2026-10-01T12:00:00.000Z');
const WEIGHTS = { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 };

let world;

// Weekly championship row as Prisma stores it; endDate is the Sunday of its last week. Verão 2027 runs 6 weeks from 2026-11-09 (now in week 3)
function championship(overrides = {}) {
  const startDate = dateOnly(overrides.start ?? '2026-11-09');
  const weeks = overrides.weeks ?? 6;
  const { start, ...rest } = overrides;
  return {
    id: 'verao',
    trainerId: TRAINER,
    name: 'Verão 2027',
    description: 'Prêmio: camiseta',
    format: 'weeks',
    startDate,
    endDate: new Date(startDate.getTime() + (weeks * 7 - 1) * 86400000),
    weeks,
    minPodiumWeeks: 2,
    anonymousRanking: false,
    visibility: ChallengeVisibility.FULL,
    ownerType: 'trainer',
    cancelledAt: null,
    closedAt: null,
    closeRequestedAt: null,
    startScheduledAt: null,
    weights: WEIGHTS,
    activePillars: ['workouts', 'cardio'],
    createdAt: JOINED,
    ...rest,
    weeks,
  };
}

// Adds a student linked to the trainer who chose to appear by name unless told otherwise
function addStudent(id, firstName, lastName, { birthDate = null, appearAs = AppearAs.NAME } = {}) {
  world.tables.user.push({ id, firstName, lastName, username: id, avatarUrl: `https://cdn/${id}.png`, birthDate, email: `${id}@example.com` });
  world.tables.trainerStudent.push({ id: `ts-${id}`, trainerId: TRAINER, studentId: id, activeOnPlan: true, createdAt: OLD_LINK });
  if (appearAs !== AppearAs.PENDING) {
    world.tables.consistencyPrivacyPref.push({ id: `pp-${id}`, studentId: id, appearAs, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: OLD_LINK });
  }
}

// Adds a championship with its participants (joined before it started unless given)
function addChampionship(row, participants) {
  world.tables.challenge.push(row);
  for (const entry of participants) {
    const [studentId, createdAt] = Array.isArray(entry) ? entry : [entry, JOINED];
    world.tables.challengeParticipant.push({ id: `cp-${row.id}-${studentId}`, challengeId: row.id, studentId, createdAt });
  }
  return row;
}

// Closed weeks of a student keyed by Monday, each with workouts done out of 4 and cardio complete
function closedWeeks(studentId, workoutsByWeek) {
  for (const [week, workoutsDone] of Object.entries(workoutsByWeek)) {
    world.tables.consistencyWeeklyResult.push(weeklyResult(TRAINER, studentId, week, { workouts: [workoutsDone, 4], cardio: [2, 2] }));
  }
}

// Ana (100, 100), Camila (66.6667, 100 -> 83.3334) and Bruno (33.3333, 66.6667 -> 50) in Verão 2027 (workouts 30, cardio 15), with Camila at 2 of 4 workouts and 1 of 2 cardio this week (50)
function exampleTeam(overrides = {}) {
  addStudent('ana', 'Ana', 'Souza');
  addStudent('camila', 'Camila', 'Rocha');
  addStudent('bruno', 'Bruno', 'Costa');
  closedWeeks('ana', { '2026-11-09': 4, '2026-11-16': 4 });
  closedWeeks('camila', { '2026-11-09': 2, '2026-11-16': 4 });
  closedWeeks('bruno', { '2026-11-09': 0, '2026-11-16': 2 });
  world.targets.set('camila', { workouts: 4, cardio: 2 });
  world.done.set('camila', { workouts: 2, cardio: 1 });
  return addChampionship(championship(overrides), ['ana', 'camila', 'bruno']);
}

// Board of Verão 2027 as Camila sees it
const camilaBoard = (options = {}, challengeId = 'verao') => getStudentBoard(world.prisma, 'camila', challengeId, options, NOW);

beforeEach(() => {
  world = createWorld();
  materializeTargets.mockImplementation(countsFrom(world.targets));
  countDone.mockImplementation(countsFrom(world.done));
});

describe('getStudentBoard', () => {
  it('APP-14 pages the full list 20 at a time', async () => {
    addStudent('camila', 'Camila', 'Rocha');
    closedWeeks('camila', { '2026-11-09': 4, '2026-11-16': 4 });
    const others = Array.from({ length: 24 }, (_, index) => `aluno-${String(index + 1).padStart(2, '0')}`);
    others.forEach((id, index) => {
      addStudent(id, `Aluno${index + 1}`, 'Teste');
      closedWeeks(id, { '2026-11-09': index % 5, '2026-11-16': (index + 1) % 5 });
    });
    addChampionship(championship(), ['camila', ...others]);

    const first = await camilaBoard({ page: 1 });
    const second = await camilaBoard({ page: 2 });

    expect(first.board).toMatchObject({ total: 25, page: 1, pageSize: 20, totalPages: 2 });
    expect(first.board.items).toHaveLength(20);
    expect(second.board).toMatchObject({ total: 25, page: 2, totalPages: 2 });
    expect(second.board.items).toHaveLength(5);
    const pagedNames = [...first.board.items, ...second.board.items].map((row) => row.displayName);
    expect(new Set(pagedNames).size).toBe(25);
    expect(first.board.items[0]).toMatchObject({ displayName: 'Camila R.', position: 1, isMe: true });
    const positions = [...first.board.items, ...second.board.items].map((row) => row.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('APP-15 lists entering participants with the weeks they still need', async () => {
    exampleTeam();
    addStudent('isabela', 'Isabela', 'Nunes');
    world.tables.challengeParticipant.push({ id: 'cp-isa', challengeId: 'verao', studentId: 'isabela', createdAt: new Date('2026-11-17T13:00:00.000Z') });
    closedWeeks('isabela', { '2026-11-16': 4 });
    world.targets.set('isabela', { workouts: 4, cardio: 2 });
    world.done.set('isabela', { workouts: 4, cardio: 2 });

    const { board } = await camilaBoard();

    expect(board.entering).toHaveLength(1);
    expect(board.entering[0]).toMatchObject({
      displayName: 'Isabela N.',
      position: null,
      faixa: Faixa.ENTERING,
      average: 100,
      validWeeks: 1,
      required: 2,
      weeksMissing: 1,
    });
    expect(board.items.map((row) => row.displayName)).not.toContain('Isabela N.');
  });

  it('APP-18 returns the trainer close instant of the week', async () => {
    exampleTeam();
    world.tables.consistencyScoringRule.push({
      id: 'rule-1', trainerId: TRAINER, effectiveFrom: dateOnly('2026-01-05'), weights: WEIGHTS,
      activePillars: ['workouts', 'cardio', 'feedback', 'hydration'], closeWeekday: 6, closeHour: 20, timeZone: SP, createdAt: OLD_LINK,
    });

    const result = await camilaBoard();

    const saturdayAt20InSaoPaulo = new Date('2026-11-28T23:00:00.000Z');
    expect(result.closesAt).toEqual(saturdayAt20InSaoPaulo);
    expect(result.me.week.closesAt).toEqual(saturdayAt20InSaoPaulo);
  });

  it('APP-19 tells the student how many weeks remain for the podium', async () => {
    exampleTeam();
    world.tables.challengeParticipant.find((row) => row.studentId === 'camila').createdAt = new Date('2026-11-17T13:00:00.000Z');

    const { me } = await camilaBoard();

    expect(me).toMatchObject({ position: null, faixa: Faixa.ENTERING, entering: { validWeeks: 1, required: 2, weeksMissing: 1 } });
  });

  it('APP-26 returns average, position, band, weeks at 100 as X of Y and streak', async () => {
    exampleTeam();

    const { me, challenge } = await camilaBoard();

    expect(challenge).toMatchObject({ currentWeek: 3, weeks: 6, status: ChallengeStatus.ACTIVE });
    expect(me).toMatchObject({
      average: 83.3334,
      position: 2,
      total: 3,
      faixa: Faixa.STEADY,
      weeks100: { done: 1, of: 2 },
      streak: 1,
      entering: null,
      appearsAs: 'Camila R.',
    });
  });

  it('APP-27 marks each championship week as full, below, paused, neutral, live or future', async () => {
    addStudent('camila', 'Camila', 'Rocha');
    closedWeeks('camila', { '2026-10-26': 4, '2026-11-02': 4, '2026-11-09': 2 });
    world.tables.consistencyWeeklyResult.push(weeklyResult(TRAINER, 'camila', '2026-11-16', { workouts: [1, 4], cardio: [0, 2] }, { status: WeekStatus.PAUSED }));
    world.targets.set('camila', { workouts: 4, cardio: 2 });
    world.done.set('camila', { workouts: 2, cardio: 1 });
    addChampionship(championship({ start: '2026-10-26', weeks: 6 }), [['camila', new Date('2026-10-27T13:00:00.000Z')]]);

    const { me } = await camilaBoard();

    expect(me.weekStrip).toEqual([
      { week: 1, weekStart: '2026-10-26', status: WeekStripStatus.NEUTRAL, score: null },
      { week: 2, weekStart: '2026-11-02', status: WeekStripStatus.FULL, score: 100 },
      { week: 3, weekStart: '2026-11-09', status: WeekStripStatus.BELOW, score: 66.6667 },
      { week: 4, weekStart: '2026-11-16', status: WeekStripStatus.PAUSED, score: null },
      { week: 5, weekStart: '2026-11-23', status: WeekStripStatus.LIVE, score: 50 },
      { week: 6, weekStart: '2026-11-30', status: WeekStripStatus.FUTURE, score: null },
    ]);
  });

  it('APP-29 returns the championship effective weights', async () => {
    exampleTeam({ activePillars: ['workouts', 'cardio', 'feedback', 'hydration'] });

    const { me } = await camilaBoard();

    expect(me.effectiveWeights).toEqual([
      { pillar: 'workouts', weight: 30, percent: 42.9 },
      { pillar: 'cardio', weight: 15, percent: 21.4 },
      { pillar: 'feedback', weight: 15, percent: 21.4 },
      { pillar: 'hydration', weight: 10, percent: 14.3 },
    ]);
  });

  it('APP-30 flags the paused week', async () => {
    exampleTeam();
    world.tables.consistencyWeekPause.push({ id: 'pause-1', trainerId: TRAINER, studentId: null, weekStart: dateOnly('2026-11-23'), paused: true, reason: null });

    const { me } = await camilaBoard();

    expect(me.week).toMatchObject({ paused: true, status: WeekStatus.PAUSED, score: null });
    expect(me.weekStrip[2]).toMatchObject({ weekStart: '2026-11-23', status: WeekStripStatus.PAUSED });
  });

  it('APP-31 tells how many share the first place', async () => {
    addStudent('ana', 'Ana', 'Souza');
    addStudent('camila', 'Camila', 'Rocha');
    addStudent('bruno', 'Bruno', 'Costa');
    addStudent('lucas', 'Lucas', 'Mendes');
    for (const id of ['ana', 'camila', 'bruno']) closedWeeks(id, { '2026-11-09': 4, '2026-11-16': 4 });
    closedWeeks('lucas', { '2026-11-09': 4, '2026-11-16': 2 });
    addChampionship(championship(), ['ana', 'camila', 'bruno', 'lucas']);

    const { me, board } = await camilaBoard();
    const lucasView = await getStudentBoard(world.prisma, 'lucas', 'verao', {}, NOW);

    expect(me).toMatchObject({ position: 1, firstPlaceShared: 2 });
    expect(board.podium.map((row) => [row.position, row.shared])).toEqual([[1, true], [1, true], [1, true]]);
    expect(lucasView.me).toMatchObject({ position: 4, firstPlaceShared: null });
  });

  it('APP-37 applies a new visibility on the next read of that championship only', async () => {
    const verao = exampleTeam();
    addChampionship(championship({ id: 'turma', name: 'Turma da manhã' }), ['ana', 'camila', 'bruno']);
    const before = await camilaBoard();

    verao.visibility = ChallengeVisibility.OFF;
    const verAoAfter = await camilaBoard();
    const turmaAfter = await camilaBoard({}, 'turma');

    expect(before.board.total).toBe(3);
    expect(verAoAfter).toMatchObject({ visibility: ChallengeVisibility.OFF, board: null, me: { position: null } });
    expect(turmaAfter).toMatchObject({ visibility: ChallengeVisibility.FULL, me: { position: 2 } });
    expect(turmaAfter.board.total).toBe(3);
  });

  it('APP-42 shows a minor to the others as Aluno do time', async () => {
    exampleTeam();
    world.tables.user.find((user) => user.id === 'bruno').birthDate = dateOnly('2010-03-15');

    const camilaView = await camilaBoard();
    const brunoView = await getStudentBoard(world.prisma, 'bruno', 'verao', {}, NOW);

    const bruno = camilaView.board.items.find((row) => row.position === 3);
    expect(bruno).toMatchObject({ displayName: 'Aluno do time', avatarUrl: null, initials: '' });
    expect(camilaView.board.items.find((row) => row.position === 1)).toMatchObject({ displayName: 'Ana S.', avatarUrl: 'https://cdn/ana.png' });
    expect(brunoView).toMatchObject({ visibility: ChallengeVisibility.OFF, board: null, me: { position: null, appearsAs: 'Aluno do time' } });
  });

  it('APP-46 returns a podium with the student alone and no neighbors', async () => {
    addStudent('camila', 'Camila', 'Rocha');
    closedWeeks('camila', { '2026-11-09': 4, '2026-11-16': 2 });
    addChampionship(championship(), ['camila']);

    const { board } = await camilaBoard();

    expect(board.podium).toEqual([expect.objectContaining({ displayName: 'Camila R.', position: 1, isMe: true, shared: false })]);
    expect(board.neighbors).toEqual([]);
    expect(board.total).toBe(1);
  });

  it('APP-55 returns name, description, start and participant count without positions for a scheduled championship', async () => {
    addStudent('camila', 'Camila', 'Rocha');
    addStudent('ana', 'Ana', 'Souza');
    addChampionship(championship({ start: '2026-12-07', weeks: 4 }), ['camila', 'ana']);

    const result = await camilaBoard();

    expect(result.challenge).toMatchObject({
      name: 'Verão 2027',
      description: 'Prêmio: camiseta',
      status: ChallengeStatus.SCHEDULED,
      startDate: '2026-12-07',
      participantCount: 2,
    });
    expect(result.me).toBeNull();
    expect(result.board).toBeNull();
  });

  it('APP-56 returns the frozen final standings of a closed championship', async () => {
    exampleTeam({ start: '2026-10-26', weeks: 3, closedAt: new Date('2026-11-16T00:30:00.000Z') });
    const frozen = [['bruno', 1, 98], ['camila', 2, 93], ['ana', 3, 90]];
    for (const [studentId, position, average] of frozen) {
      world.tables.challengeConsistencyStanding.push({
        id: `cs-${studentId}`, challengeId: 'verao', studentId, position, eligible: true, average, validWeeks: 3, weeks100: 0, streak: 0, frozenAt: new Date('2026-11-16T00:30:00.000Z'),
      });
    }

    const result = await camilaBoard();

    expect(result.challenge).toMatchObject({ status: ChallengeStatus.COMPLETED, closedAt: new Date('2026-11-16T00:30:00.000Z'), currentWeek: 3 });
    expect(result.closesAt).toBeNull();
    expect(result.board.podium.map((row) => [row.displayName, row.position, row.average])).toEqual([
      ['Bruno C.', 1, 98], ['Camila R.', 2, 93], ['Ana S.', 3, 90],
    ]);
    expect(result.me).toMatchObject({ position: 2, average: 93, total: 3, week: null, weeks100: { done: 0, of: 3 } });
  });

  it('APP-60 answers 404 for a championship the student is not in, a cancelled one or a dates one', async () => {
    exampleTeam();
    addStudent('outra', 'Outra', 'Pessoa');
    addChampionship(championship({ id: 'cancelado', cancelledAt: new Date('2026-11-20T12:00:00.000Z') }), ['camila']);
    addChampionship(championship({ id: 'xp', format: 'dates', weights: null, activePillars: [] }), ['camila']);

    for (const [studentId, challengeId] of [['outra', 'verao'], ['camila', 'cancelado'], ['camila', 'xp'], ['camila', 'nao-existe']]) {
      await expect(getStudentBoard(world.prisma, studentId, challengeId, {}, NOW)).rejects.toMatchObject({
        httpStatus: 404,
        error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
        messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
      });
    }
  });

  it('APP-61 returns only the student row with position only and no position with off', async () => {
    const verao = exampleTeam();

    verao.visibility = ChallengeVisibility.POSITION;
    const positionOnly = await camilaBoard();
    verao.visibility = ChallengeVisibility.OFF;
    const off = await camilaBoard();

    expect(positionOnly.board).toBeNull();
    expect(positionOnly.me).toMatchObject({ position: 2, total: 3, faixa: Faixa.STEADY, average: null });
    expect(off.board).toBeNull();
    expect(off.me).toMatchObject({ position: null, total: null, faixa: null, average: null, weeks100: null, streak: null });
    expect(off.me.week).toMatchObject({ score: 50 });
  });
});

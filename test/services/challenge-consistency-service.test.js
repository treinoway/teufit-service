import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computeChallengeStandings,
  getChallengeConsistency,
} from '../../src/services/challenge-consistency-service.js';
import { getConfig, ruleForWeek } from '../../src/services/consistency-config-service.js';
import { evaluateRunningWeek } from '../../src/services/consistency-standings-service.js';
import { liveAverage, seasonFigures } from '../../src/helpers/consistency-math.js';
import { ChallengeErrorCode, ChallengeMessageCode, ChallengeStatus } from '../../src/constants/challenge.js';
import { Faixa, WeekStatus } from '../../src/constants/consistency-ranking.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn(), ruleForWeek: vi.fn() }));
vi.mock('../../src/services/consistency-standings-service.js', () => ({ evaluateRunningWeek: vi.fn() }));

const { Decimal } = Prisma;
const SP = 'America/Sao_Paulo';
const TRAINER_ID = 'trainer-1';
const TRAINER_USER_ID = 'trainer-user-1';
const CHALLENGE_ID = 'champ-1';
// Wednesday 2026-11-18 12:00 in São Paulo; the running week starts Monday 2026-11-16
const NOW = new Date('2026-11-18T15:00:00.000Z');
const RULE = {
  weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
  activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
  closeWeekday: 0,
  closeHour: 21,
  timeZone: SP,
};
const CONFIG = { ...RULE, seasonWeeks: 4, minPodiumWeeks: 2 };
const BEFORE_START = new Date('2026-10-30T12:00:00.000Z');
const OLD_LINK = new Date('2026-01-01T00:00:00.000Z');

const prisma = {
  trainer: { findUnique: vi.fn() },
  challenge: { findUnique: vi.fn() },
  challengeParticipant: { findMany: vi.fn(), count: vi.fn() },
  trainerStudent: { findMany: vi.fn() },
  consistencyWeeklyResult: { findMany: vi.fn() },
  challengeConsistencyStanding: { findMany: vi.fn() },
};

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Weekly championship of 4 weeks from Monday 2026-11-02 (the running week is its 3rd) unless overridden
function championship(overrides = {}) {
  return {
    id: CHALLENGE_ID,
    trainerId: TRAINER_ID,
    name: 'Desafio de novembro',
    description: 'Prêmio: camiseta',
    format: 'weeks',
    startDate: dateOnly('2026-11-02'),
    endDate: dateOnly('2026-11-29'),
    weeks: 4,
    minPodiumWeeks: 2,
    anonymousRanking: false,
    visibility: 'full',
    ownerType: 'trainer',
    cancelledAt: null,
    closedAt: null,
    closeRequestedAt: null,
    ...overrides,
  };
}

// Participant row with its student
function participant(studentId, firstName, lastName, createdAt = BEFORE_START) {
  return { studentId, createdAt, student: { firstName, lastName, username: studentId } };
}

// Stored weekly result of a student
function result(studentId, week, score, status = WeekStatus.VALID) {
  return { studentId, seasonId: 's1', weekStart: dateOnly(week), status, score: score === null ? null : new Decimal(score) };
}

// Running-week outcome as evaluateRunningWeek returns it
function running(partial, status = WeekStatus.VALID) {
  return { status, partial: partial === null ? null : new Decimal(partial), pillars: {} };
}

// Wires the reads of one championship: participants, active links (default: all), stored results and running outcomes
function arrange({ participants, links, results = [], runningWeek = {} }) {
  prisma.challengeParticipant.findMany.mockResolvedValue(participants);
  prisma.trainerStudent.findMany.mockResolvedValue(
    links ?? participants.map((row) => ({ studentId: row.studentId, createdAt: OLD_LINK })),
  );
  prisma.consistencyWeeklyResult.findMany.mockResolvedValue(results);
  evaluateRunningWeek.mockImplementation(async (_prisma, _trainerId, _monday, evaluated) => new Map(
    evaluated.map((link) => [link.studentId, runningWeek[link.studentId] ?? running(null, WeekStatus.NEUTRAL)]),
  ));
}

// Row of a student in the ranked rows or the entering list
function rowOf(standings, studentId) {
  return [...standings.rows, ...standings.entering].find((row) => row.studentId === studentId);
}

beforeEach(() => {
  getConfig.mockResolvedValue(CONFIG);
  ruleForWeek.mockResolvedValue(RULE);
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  prisma.challengeParticipant.count.mockResolvedValue(0);
});

describe('computeChallengeStandings', () => {
  it('CAMP-20 Independent Test: 95 in the championship and 76.6667 in the team season', async () => {
    const results = [
      result('ana', '2026-11-09', 90),
      result('ana', '2026-11-02', 100),
      result('ana', '2026-10-26', 40),
    ];
    arrange({ participants: [participant('ana', 'Ana', 'Souza')], results });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(rowOf(standings, 'ana')).toMatchObject({ average: 95, validWeeks: 2, eligible: true, position: 1 });
    expect(Number(liveAverage(seasonFigures(results, 's1').scores, null))).toBe(76.6667);
  });

  it('CAMP-11 makes the current week neutral when created after Monday 00:00', async () => {
    const createdWednesday = new Date('2026-11-18T13:00:00.000Z');
    arrange({
      participants: [participant('ana', 'Ana', 'Souza', createdWednesday)],
      runningWeek: { ana: running(80) },
    });

    const standings = await computeChallengeStandings(
      prisma,
      championship({ startDate: dateOnly('2026-11-16'), endDate: dateOnly('2026-11-29'), weeks: 2 }),
      NOW,
    );

    expect(standings.rows).toEqual([]);
    expect(standings.entering).toEqual([]);
    expect(evaluateRunningWeek).not.toHaveBeenCalled();
  });

  it('CAMP-11 makes the current week neutral when an edit moved the start into it after Monday 00:00', async () => {
    const joinedTuesdayBefore = new Date('2026-11-10T13:00:00.000Z');
    const movedWednesday = new Date('2026-11-18T13:00:00.000Z');
    arrange({
      participants: [participant('ana', 'Ana', 'Souza', joinedTuesdayBefore)],
      runningWeek: { ana: running(80) },
    });

    const standings = await computeChallengeStandings(
      prisma,
      championship({ startDate: dateOnly('2026-11-16'), endDate: dateOnly('2026-11-29'), weeks: 2, startScheduledAt: movedWednesday }),
      NOW,
    );

    expect(standings.rows).toEqual([]);
    expect(standings.entering).toEqual([]);
    expect(evaluateRunningWeek).not.toHaveBeenCalled();
  });

  it('CAMP-15 counts an added participant from the entry', async () => {
    const addedSundayBeforeWeek2 = new Date('2026-11-08T20:00:00.000Z');
    arrange({
      participants: [participant('bia', 'Bia', 'Lima', addedSundayBeforeWeek2)],
      results: [result('bia', '2026-11-09', 80), result('bia', '2026-11-02', 100)],
      runningWeek: { bia: running(60) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(rowOf(standings, 'bia')).toMatchObject({ validWeeks: 2, average: 80, currentWeekScore: 60, eligible: true });
    expect(evaluateRunningWeek).toHaveBeenCalledWith(prisma, TRAINER_ID, dateOnly('2026-11-16'), [
      { studentId: 'bia', createdAt: addedSundayBeforeWeek2 },
    ]);
  });

  it('CAMP-17 treats weeks started before the entry as neutral', async () => {
    const addedTuesdayOfWeek2 = new Date('2026-11-10T13:00:00.000Z');
    arrange({
      participants: [participant('caio', 'Caio', 'Reis', addedTuesdayOfWeek2)],
      results: [result('caio', '2026-11-09', 100), result('caio', '2026-11-02', 100)],
      runningWeek: { caio: running(70) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(rowOf(standings, 'caio')).toMatchObject({
      validWeeks: 1,
      average: 70,
      weeksAt100: 0,
      eligible: false,
      weeksMissing: 1,
    });
  });

  it('CAMP-19 leaves out students inactive on the plan or unlinked', async () => {
    arrange({
      participants: [participant('ana', 'Ana', 'Souza'), participant('inativo', 'Ivo', 'Neto'), participant('sem-vinculo', 'Sara', 'Melo')],
      links: [{ studentId: 'ana', createdAt: OLD_LINK }],
      results: [
        result('ana', '2026-11-09', 90),
        result('inativo', '2026-11-09', 100),
        result('sem-vinculo', '2026-11-09', 100),
      ],
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect([...standings.rows, ...standings.entering].map((row) => row.studentId)).toEqual(['ana']);
    expect(prisma.trainerStudent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ trainerId: TRAINER_ID, activeOnPlan: true }),
    }));
  });

  it('CAMP-20 averages only the valid weeks inside the championship', async () => {
    arrange({
      participants: [participant('ana', 'Ana', 'Souza')],
      results: [
        result('ana', '2026-11-30', 10),
        result('ana', '2026-11-09', null, WeekStatus.PAUSED),
        result('ana', '2026-11-02', 85),
        result('ana', '2026-10-26', 20),
      ],
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(rowOf(standings, 'ana')).toMatchObject({ average: 85, validWeeks: 1 });
  });

  it('CAMP-21 never lowers the average during the running week', async () => {
    arrange({
      participants: [participant('ana', 'Ana', 'Souza'), participant('bia', 'Bia', 'Lima'), participant('caio', 'Caio', 'Reis')],
      results: [
        result('ana', '2026-11-09', 80), result('ana', '2026-11-02', 100),
        result('bia', '2026-11-09', 80), result('bia', '2026-11-02', 100),
      ],
      runningWeek: { ana: running(50), bia: running(100), caio: running(62.5) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(rowOf(standings, 'ana').average).toBe(90);
    expect(rowOf(standings, 'bia').average).toBe(93.3333);
    expect(rowOf(standings, 'caio').average).toBe(62.5);
    expect(rowOf(standings, 'ana').currentWeekScore).toBe(50);
  });

  it('CAMP-22 requires min(minimum, elapsed weeks) valid weeks', async () => {
    arrange({
      participants: [participant('ana', 'Ana', 'Souza'), participant('bia', 'Bia', 'Lima')],
      results: [result('ana', '2026-11-09', 90), result('ana', '2026-11-02', 90), result('bia', '2026-11-09', 90)],
      runningWeek: { bia: running(90) },
    });

    const minimum3 = await computeChallengeStandings(prisma, championship({ minPodiumWeeks: 3 }), NOW);
    expect(rowOf(minimum3, 'ana')).toMatchObject({ eligible: false, weeksMissing: 1 });
    expect(rowOf(minimum3, 'bia')).toMatchObject({ eligible: false, weeksMissing: 1 });

    const minimum4inWeek2 = await computeChallengeStandings(
      prisma,
      championship({ startDate: dateOnly('2026-11-09'), endDate: dateOnly('2026-12-06'), minPodiumWeeks: 4 }),
      NOW,
    );
    expect(rowOf(minimum4inWeek2, 'ana')).toMatchObject({ eligible: false, validWeeks: 1, weeksMissing: 1 });
    expect(rowOf(minimum4inWeek2, 'bia')).toMatchObject({ eligible: true, validWeeks: 2 });
  });

  it('CAMP-23 orders by average, weeks at 100 and streak', async () => {
    arrange({
      participants: [
        participant('a', 'Alice', 'A'), participant('b', 'Bruno', 'B'), participant('c', 'Carla', 'C'),
        participant('d', 'Davi', 'D'), participant('e', 'Eva', 'E'),
      ],
      results: [
        result('a', '2026-11-09', 90), result('a', '2026-11-02', 90),
        result('b', '2026-11-09', 80), result('b', '2026-11-02', 100),
        result('c', '2026-11-09', 95), result('c', '2026-11-02', 95),
        result('d', '2026-11-09', 100), result('d', '2026-11-02', null, WeekStatus.NEUTRAL), result('d', '2026-10-26', 100),
        result('e', '2026-11-09', 100), result('e', '2026-11-02', null, WeekStatus.NEUTRAL), result('e', '2026-10-26', 70),
      ],
      runningWeek: { d: running(100), e: running(100) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(standings.rows.map((row) => [row.studentId, row.position, row.average, row.weeksAt100, row.streak])).toEqual([
      ['d', 1, 100, 1, 2],
      ['e', 2, 100, 1, 1],
      ['c', 3, 95, 0, 0],
      ['b', 4, 90, 1, 0],
      ['a', 5, 90, 0, 0],
    ]);
  });

  it('CAMP-24 shares positions and skips the next', async () => {
    arrange({
      participants: [
        participant('d', 'Daniela', 'D'), participant('c', 'Carla', 'C'),
        participant('b', 'Bruna', 'B'), participant('a', 'Amanda', 'A'),
      ],
      results: [
        result('a', '2026-11-09', 100), result('a', '2026-11-02', 100),
        result('b', '2026-11-09', 90), result('b', '2026-11-02', 90),
        result('c', '2026-11-09', 90), result('c', '2026-11-02', 90),
        result('d', '2026-11-09', 80), result('d', '2026-11-02', 80),
      ],
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(standings.rows.map((row) => [row.name, row.position])).toEqual([
      ['Amanda A', 1],
      ['Bruna B', 2],
      ['Carla C', 2],
      ['Daniela D', 4],
    ]);
  });

  it('CAMP-25 lists entering participants with the weeks missing', async () => {
    arrange({
      participants: [participant('zeca', 'Zeca', 'Z'), participant('beto', 'Beto', 'B'), participant('ana', 'Ana', 'A')],
      results: [result('ana', '2026-11-09', 90), result('ana', '2026-11-02', 90), result('zeca', '2026-11-09', 70)],
      runningWeek: { beto: running(50) },
    });

    const standings = await computeChallengeStandings(prisma, championship({ minPodiumWeeks: 3 }), NOW);

    expect(standings.rows).toEqual([]);
    expect(standings.entering.map((row) => [row.name, row.position, row.validWeeks, row.weeksMissing, row.entering])).toEqual([
      ['Ana A', null, 2, 1, { validWeeks: 2, required: 3 }],
      ['Beto B', null, 1, 2, { validWeeks: 1, required: 3 }],
      ['Zeca Z', null, 1, 2, { validWeeks: 1, required: 3 }],
    ]);
    expect(standings.entering.every((row) => row.faixa === Faixa.ENTERING)).toBe(true);
  });

  it('CAMP-26 leaves out participants without a valid week and a neutral or paused current week', async () => {
    arrange({
      participants: [participant('neutro', 'Nina', 'N'), participant('pausado', 'Paulo', 'P'), participant('valido', 'Vera', 'V')],
      results: [result('neutro', '2026-11-09', null, WeekStatus.NEUTRAL), result('pausado', '2026-11-02', null, WeekStatus.PAUSED)],
      runningWeek: { neutro: running(null, WeekStatus.NEUTRAL), pausado: running(null, WeekStatus.PAUSED), valido: running(40) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect([...standings.rows, ...standings.entering].map((row) => row.studentId)).toEqual(['valido']);
  });

  it('CAMP-27 gives the same week score in every championship', async () => {
    arrange({
      participants: [participant('ana', 'Ana', 'Souza')],
      results: [result('ana', '2026-11-09', 90), result('ana', '2026-11-02', 100)],
      runningWeek: { ana: running(75) },
    });

    const fourWeeks = await computeChallengeStandings(prisma, championship(), NOW);
    const twoWeeks = await computeChallengeStandings(
      prisma,
      championship({ id: 'champ-2', startDate: dateOnly('2026-11-09'), endDate: dateOnly('2026-11-22'), weeks: 2 }),
      NOW,
    );

    expect(rowOf(fourWeeks, 'ana').currentWeekScore).toBe(75);
    expect(rowOf(twoWeeks, 'ana').currentWeekScore).toBe(75);
    expect(rowOf(fourWeeks, 'ana').average).toBe(95);
    expect(rowOf(twoWeeks, 'ana').average).toBe(90);
    expect(evaluateRunningWeek.mock.calls.map((call) => call[2])).toEqual([dateOnly('2026-11-16'), dateOnly('2026-11-16')]);
  });

  it('CAMP-68 applies a new close time from the next week', async () => {
    const saturday18 = { ...RULE, closeWeekday: 6, closeHour: 18 };
    ruleForWeek.mockImplementation(async (_prisma, _trainerId, { day, month }) => (
      month === 11 && day >= 23 ? saturday18 : RULE
    ));
    arrange({ participants: [participant('ana', 'Ana', 'Souza')], results: [result('ana', '2026-11-09', 90)] });

    const thisWeek = await computeChallengeStandings(prisma, championship(), NOW);
    const nextWeek = await computeChallengeStandings(prisma, championship(), new Date('2026-11-25T15:00:00.000Z'));

    expect(thisWeek.closesAt).toEqual(new Date('2026-11-23T00:00:00.000Z'));
    expect(nextWeek.closesAt).toEqual(new Date('2026-11-28T21:00:00.000Z'));
    expect(thisWeek.currentWeek).toBe(3);
    expect(nextWeek.currentWeek).toBe(4);
  });

  it('CAMP-29 returns the row fields with the faixa of the championship average', async () => {
    arrange({
      participants: [participant('ana', 'Ana Maria', 'de Souza')],
      results: [result('ana', '2026-11-09', 100), result('ana', '2026-11-02', 100)],
      runningWeek: { ana: running(100) },
    });

    const standings = await computeChallengeStandings(prisma, championship(), NOW);

    expect(standings.rows[0]).toEqual({
      studentId: 'ana',
      name: 'Ana Maria de Souza',
      displayName: 'Ana Maria S.',
      initials: 'AS',
      position: 1,
      eligible: true,
      faixa: Faixa.FULL,
      average: 100,
      validWeeks: 3,
      weeks100: 2,
      weeksAt100: 2,
      streak: 2,
      currentWeekScore: 100,
      weekStatus: WeekStatus.VALID,
      entering: null,
      weeksMissing: 0,
    });
  });

  it('CAMP-32 uses the stored result of the last week once it closed, without a running partial', async () => {
    const sundayAfterClose = new Date('2026-11-30T00:15:00.000Z');
    arrange({
      participants: [participant('ana', 'Ana', 'Souza')],
      results: [
        result('ana', '2026-11-23', 100), result('ana', '2026-11-16', 90),
        result('ana', '2026-11-09', 80), result('ana', '2026-11-02', 70),
      ],
    });

    const standings = await computeChallengeStandings(prisma, championship(), sundayAfterClose);

    expect(rowOf(standings, 'ana')).toMatchObject({ average: 85, validWeeks: 4, streak: 1, currentWeekScore: null });
    expect(evaluateRunningWeek).not.toHaveBeenCalled();
  });
});

describe('getChallengeConsistency', () => {
  it('CAMP-30 returns empty standings and the start for a scheduled championship', async () => {
    prisma.challenge.findUnique.mockResolvedValue(
      championship({ startDate: dateOnly('2026-11-23'), endDate: dateOnly('2026-12-20') }),
    );
    prisma.challengeParticipant.count.mockResolvedValue(3);

    const response = await getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW);

    expect(response).toMatchObject({
      status: ChallengeStatus.SCHEDULED,
      currentWeek: null,
      closesAt: null,
      rows: [],
      entering: [],
      challenge: { id: CHALLENGE_ID, startDate: '2026-11-23', endDate: '2026-12-20', weeks: 4, participantCount: 3 },
    });
    expect(prisma.challengeParticipant.findMany).not.toHaveBeenCalled();
  });

  it('CAMP-31 returns full names to the trainer with anonymous ranking on', async () => {
    prisma.challenge.findUnique.mockResolvedValue(championship({ anonymousRanking: true }));
    arrange({
      participants: [participant('ana', 'Ana', 'Souza')],
      results: [result('ana', '2026-11-09', 90), result('ana', '2026-11-02', 90)],
    });

    const response = await getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW);

    expect(response.status).toBe(ChallengeStatus.ACTIVE);
    expect(response.currentWeek).toBe(3);
    expect(response.challenge.anonymousRanking).toBe(true);
    expect(response.rows[0]).toMatchObject({ name: 'Ana Souza', displayName: 'Ana S.', position: 1, average: 90 });
  });

  it('CAMP-37 returns the frozen standings of a closed championship, ignoring later results', async () => {
    prisma.challenge.findUnique.mockResolvedValue(championship({ closedAt: new Date('2026-11-30T00:10:00.000Z') }));
    prisma.challengeConsistencyStanding.findMany.mockResolvedValue([
      { studentId: 'b', position: 2, eligible: true, average: new Decimal(80), validWeeks: 3, weeks100: 0, streak: 0, student: { firstName: 'Bia', lastName: 'B' } },
      { studentId: 'c', position: null, eligible: false, average: new Decimal(60), validWeeks: 1, weeks100: 0, streak: 0, student: { firstName: 'Caio', lastName: 'C' } },
      { studentId: 'a', position: 1, eligible: true, average: new Decimal(95.5), validWeeks: 4, weeks100: 2, streak: 2, student: { firstName: 'Ana', lastName: 'A' } },
    ]);

    const response = await getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, new Date('2026-12-10T15:00:00.000Z'));

    expect(response.status).toBe(ChallengeStatus.COMPLETED);
    expect(response.rows.map((row) => [row.studentId, row.position, row.average, row.faixa])).toEqual([
      ['a', 1, 95.5, Faixa.CONSTANT],
      ['b', 2, 80, Faixa.STEADY],
    ]);
    expect(response.entering).toMatchObject([{ studentId: 'c', position: null, weeksMissing: 1 }]);
    expect(prisma.consistencyWeeklyResult.findMany).not.toHaveBeenCalled();
    expect(evaluateRunningWeek).not.toHaveBeenCalled();
  });

  it('CAMP-43 returns no standings for a cancelled championship', async () => {
    prisma.challenge.findUnique.mockResolvedValue(championship({ cancelledAt: new Date('2026-11-17T10:00:00.000Z') }));

    const response = await getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW);

    expect(response).toMatchObject({ status: ChallengeStatus.CANCELLED, rows: [], entering: [] });
  });

  it('CAMP-66 answers 409 challenge.notWeekly for a dates championship', async () => {
    prisma.challenge.findUnique.mockResolvedValue(championship({ format: 'dates' }));

    await expect(getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW)).rejects.toMatchObject({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_NOT_WEEKLY,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_WEEKLY,
    });
  });

  it('CAMP-65 answers 403 to another trainer and 404 to an unknown championship', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce(championship({ trainerId: 'other-trainer' }));
    await expect(getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW)).rejects.toMatchObject({
      httpStatus: 403,
      messageCode: ChallengeMessageCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
    });

    prisma.challenge.findUnique.mockResolvedValueOnce(null);
    await expect(getChallengeConsistency(prisma, TRAINER_USER_ID, CHALLENGE_ID, NOW)).rejects.toMatchObject({
      httpStatus: 404,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
    });
  });
});

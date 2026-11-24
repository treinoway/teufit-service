import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStudentOverview } from '../../src/services/consistency-student-overview-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { ChallengeVisibility } from '../../src/constants/challenge.js';
import {
  AppearAs,
  CONSISTENCY_PRIVACY_TERM_VERSION,
  Faixa,
  StudentOverviewState,
  WEEK_COMPLETE_SENTENCE,
} from '../../src/constants/consistency-ranking.js';
import { countsFrom, createWorld, dateOnly, weeklyResult } from '../helpers/consistency-student-world.js';

vi.mock('../../src/services/consistency-target-service.js', async (importOriginal) => ({ ...(await importOriginal()), materializeTargets: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', async (importOriginal) => ({ ...(await importOriginal()), countDone: vi.fn() }));

const SP = 'America/Sao_Paulo';
const TRAINER = 'trainer-1';
// Wednesday 2026-11-25 12:00 in São Paulo; the running week starts Monday 2026-11-23 and closes Sunday 29 at 21:00 (trainer default)
const NOW = new Date('2026-11-25T15:00:00.000Z');
const WEEK_CLOSE = new Date('2026-11-30T00:00:00.000Z');
const OLD_LINK = new Date('2026-01-01T12:00:00.000Z');
const JOINED = new Date('2026-11-01T12:00:00.000Z');
const VERAO_WEIGHTS = { workouts: 10, diet: 20, cardio: 40, feedback: 20, hydration: 10 };
const TURMA_WEIGHTS = { workouts: 40, diet: 20, cardio: 10, feedback: 20, hydration: 10 };

let world;

// Weekly championship row as Prisma stores it; endDate is the Sunday of its last week
function championship(id, name, startWeek, weeks, overrides = {}) {
  const startDate = dateOnly(startWeek);
  return {
    id,
    trainerId: TRAINER,
    name,
    description: null,
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
    weights: VERAO_WEIGHTS,
    activePillars: ['workouts', 'cardio'],
    createdAt: JOINED,
    ...overrides,
  };
}

// Adds a student linked to the trainer
function addStudent(id, firstName, lastName, { birthDate = null, activeOnPlan = true } = {}) {
  world.tables.user.push({ id, firstName, lastName, username: id, avatarUrl: null, birthDate, email: `${id}@example.com` });
  world.tables.trainerStudent.push({ id: `ts-${id}`, trainerId: TRAINER, studentId: id, activeOnPlan, createdAt: OLD_LINK });
}

// Adds a championship with its participants
function addChampionship(row, studentIds) {
  world.tables.challenge.push(row);
  for (const studentId of studentIds) {
    world.tables.challengeParticipant.push({ id: `cp-${row.id}-${studentId}`, challengeId: row.id, studentId, createdAt: JOINED });
  }
  return row;
}

// Closed weeks 2026-11-09 and 2026-11-16 of a student, cardio complete, with the given workouts done out of 4
function closedWeeks(studentId, workoutsDone) {
  ['2026-11-09', '2026-11-16'].forEach((week, index) => {
    world.tables.consistencyWeeklyResult.push(weeklyResult(TRAINER, studentId, week, { workouts: [workoutsDone[index], 4], cardio: [2, 2] }));
  });
}

// Camila (3 of 4 workouts, 0 of 2 cardio this week) with Ana and Bruno; Verão 2027 (ends 20/12) and Turma da manhã (ends 27/12) running
function exampleTeam() {
  addStudent('camila', 'Camila', 'Rocha');
  addStudent('ana', 'Ana', 'Souza');
  addStudent('bruno', 'Bruno', 'Costa');
  closedWeeks('ana', [4, 4]);
  closedWeeks('camila', [2, 2]);
  closedWeeks('bruno', [0, 2]);
  world.targets.set('camila', { workouts: 4, cardio: 2 });
  world.done.set('camila', { workouts: 3, cardio: 0 });
  const verao = addChampionship(championship('verao', 'Verão 2027', '2026-11-09', 6), ['camila', 'ana', 'bruno']);
  const turma = addChampionship(championship('turma', 'Turma da manhã', '2026-11-16', 6, { weights: TURMA_WEIGHTS }), ['camila']);
  return { verao, turma };
}

beforeEach(() => {
  world = createWorld();
  materializeTargets.mockImplementation(countsFrom(world.targets));
  countDone.mockImplementation(countsFrom(world.done));
});

describe('getStudentOverview', () => {
  it('APP-02 highlights the running championship that ends first', async () => {
    exampleTeam();
    addChampionship(championship('outono', 'Outono', '2026-11-16', 5), ['camila']);

    const overview = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(overview.state).toBe(StudentOverviewState.OK);
    expect(overview.highlight).toEqual({
      challengeId: 'verao',
      name: 'Verão 2027',
      visibility: ChallengeVisibility.FULL,
      position: 2,
      total: 3,
      faixa: Faixa.CONSTANT,
      average: 90,
    });
  });

  it('APP-02 scores the week with the highlighted championship weights', async () => {
    exampleTeam();

    const overview = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(overview.week).toMatchObject({ score: 15, paused: false, closesAt: WEEK_CLOSE });
    expect(overview.week.pillars).toEqual([
      { pillar: 'workouts', done: 3, expected: 4, missing: 1, complete: false },
      { pillar: 'cardio', done: 0, expected: 2, missing: 2, complete: false },
    ]);
    expect(overview.week.missingPhrase).toBe('Faltam 1 treino e 2 cardios pra fechar tua semana.');
  });

  it('APP-04 lists only the active pillars of the highlighted championship in the missing sentence', async () => {
    exampleTeam();
    world.tables.challenge.find((row) => row.id === 'verao').activePillars = ['workouts'];

    const missingWorkout = await getStudentOverview(world.prisma, 'camila', NOW);
    world.done.set('camila', { workouts: 4, cardio: 0 });
    const workoutsDone = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(missingWorkout.week.pillars.map((row) => row.pillar)).toEqual(['workouts']);
    expect(missingWorkout.week.missingPhrase).toBe('Falta 1 treino pra fechar tua semana.');
    expect(missingWorkout.week.score).toBe(75);
    expect(workoutsDone.week.missingPhrase).toBe(WEEK_COMPLETE_SENTENCE);
    expect(workoutsDone.week.score).toBe(100);
  });

  it('APP-06 drops the position with visibility off and keeps position and band with position only', async () => {
    const { verao } = exampleTeam();

    verao.visibility = ChallengeVisibility.OFF;
    const off = await getStudentOverview(world.prisma, 'camila', NOW);
    verao.visibility = ChallengeVisibility.POSITION;
    const positionOnly = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(off.highlight).toEqual({
      challengeId: 'verao', name: 'Verão 2027', visibility: ChallengeVisibility.OFF, position: null, total: null, faixa: null, average: null,
    });
    expect(positionOnly.highlight).toEqual({
      challengeId: 'verao', name: 'Verão 2027', visibility: ChallengeVisibility.POSITION, position: 2, total: 3, faixa: Faixa.CONSTANT, average: null,
    });
    expect(off.week.score).toBe(15);
  });

  it('APP-48 counts the other running championships', async () => {
    exampleTeam();
    addChampionship(championship('futuro', 'Dezembro', '2026-12-07', 4), ['camila']);
    addChampionship(championship('cancelado', 'Cancelado', '2026-11-16', 3, { cancelledAt: new Date('2026-11-20T12:00:00.000Z') }), ['camila']);
    addChampionship(championship('xp', 'Só XP', '2026-11-16', 3, { format: 'dates', weights: null, activePillars: [] }), ['camila']);
    addChampionship(championship('sem-mim', 'Sem a Camila', '2026-11-16', 3), ['ana']);

    const overview = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(overview.highlight.name).toBe('Verão 2027');
    expect(overview.othersCount).toBe(1);
  });

  it('APP-69 scores the week with the general ranking weights without a running championship', async () => {
    addStudent('camila', 'Camila', 'Rocha');
    world.targets.set('camila', { workouts: 4, cardio: 2 });
    world.done.set('camila', { workouts: 3, cardio: 0 });
    world.tables.consistencyScoringRule.push({
      id: 'rule-1',
      trainerId: TRAINER,
      effectiveFrom: dateOnly('2026-01-05'),
      weights: { workouts: 20, diet: 0, cardio: 60, feedback: 10, hydration: 10 },
      activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
      closeWeekday: 0,
      closeHour: 21,
      timeZone: SP,
      createdAt: OLD_LINK,
    });
    addChampionship(championship('futuro', 'Dezembro', '2026-12-07', 4), ['camila']);
    addChampionship(championship('cancelado', 'Cancelado', '2026-11-16', 3, { cancelledAt: new Date('2026-11-20T12:00:00.000Z') }), ['camila']);

    const overview = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(overview.highlight).toBeNull();
    expect(overview.othersCount).toBe(0);
    expect(overview.week).toMatchObject({ score: 18.75, closesAt: WEEK_CLOSE, missingPhrase: 'Faltam 1 treino e 2 cardios pra fechar tua semana.' });
  });

  it('APP-34 answers no_trainer without an active link', async () => {
    addStudent('camila', 'Camila', 'Rocha', { activeOnPlan: false });
    addChampionship(championship('verao', 'Verão 2027', '2026-11-09', 6), ['camila']);

    const overview = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(overview).toEqual({
      state: StudentOverviewState.NO_TRAINER,
      week: null,
      highlight: null,
      othersCount: 0,
      privacy: { appearAs: AppearAs.PENDING, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: null },
    });
  });

  it('APP-42 gives a minor only the own week', async () => {
    exampleTeam();
    world.tables.consistencyPrivacyPref.push({ id: 'p1', studentId: 'camila', appearAs: AppearAs.NAME, termVersion: CONSISTENCY_PRIVACY_TERM_VERSION, acceptedAt: OLD_LINK });
    const camila = world.tables.user.find((user) => user.id === 'camila');

    camila.birthDate = dateOnly('2008-11-26');
    const minor = await getStudentOverview(world.prisma, 'camila', NOW);
    camila.birthDate = dateOnly('2008-11-25');
    const turnsEighteenToday = await getStudentOverview(world.prisma, 'camila', NOW);

    expect(minor.highlight).toEqual({
      challengeId: 'verao', name: 'Verão 2027', visibility: ChallengeVisibility.OFF, position: null, total: null, faixa: null, average: null,
    });
    expect(minor.week).toMatchObject({ score: 15, missingPhrase: 'Faltam 1 treino e 2 cardios pra fechar tua semana.' });
    expect(turnsEighteenToday.highlight).toMatchObject({ visibility: ChallengeVisibility.FULL, position: 2, total: 3 });
  });
});

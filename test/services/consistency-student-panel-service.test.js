import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getStudentPanel } from '../../src/services/consistency-student-panel-service.js';
import { getPanelStandings } from '../../src/services/consistency-standings-service.js';
import { getConfig } from '../../src/services/consistency-config-service.js';
import { ensureCurrentSeason } from '../../src/services/consistency-season-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { Faixa, Pillar, SeasonStatus, WeekStatus } from '../../src/constants/consistency-ranking.js';

vi.mock('../../src/services/consistency-standings-service.js', () => ({ getPanelStandings: vi.fn() }));
vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../src/services/consistency-season-service.js', () => ({ ensureCurrentSeason: vi.fn() }));
vi.mock('../../src/services/consistency-target-service.js', () => ({ materializeTargets: vi.fn() }));

const { Decimal } = Prisma;
const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'joao';
// Wednesday 2026-11-11 12:00 in Sao Paulo; the running week starts Monday 2026-11-09 (week 3 of 4)
const NOW = new Date('2026-11-11T15:00:00Z');
const SEASON = {
  id: 's1',
  trainerId: TRAINER_ID,
  number: 3,
  startWeek: new Date(Date.UTC(2026, 9, 26)),
  weeks: 4,
  status: SeasonStatus.ACTIVE,
};
const RISK = { weeks: 2, scores: [64, 58] };
const SEASON_PILLARS = [
  { pillar: Pillar.WORKOUTS, done: 5, expected: 6, adherence: 83.3333 },
  { pillar: Pillar.CARDIO, done: 1, expected: 4, adherence: 25 },
];

// Panel standings row of the student under test
function standingRow(overrides = {}) {
  return {
    studentId: STUDENT_ID,
    displayName: 'João V.',
    initials: 'JV',
    position: 2,
    faixa: Faixa.RESTARTING,
    average: 61,
    currentWeekScore: 40,
    weekStatus: WeekStatus.VALID,
    seasonPillars: SEASON_PILLARS,
    risk: RISK,
    signals: [],
    pause: null,
    entering: null,
    ...overrides,
  };
}

// Stored result of a closed week
function storedResult(weekStart, status, score) {
  return { studentId: STUDENT_ID, seasonId: 's1', weekStart: new Date(`${weekStart}T00:00:00Z`), status, score: score === null ? null : new Decimal(score) };
}

// Stored frozen standing of a closed season
function storedStanding(number, startWeek, average, eligible = true) {
  return {
    average: new Decimal(average),
    eligible,
    season: { number, startWeek: new Date(`${startWeek}T00:00:00Z`), weeks: 4 },
  };
}

// Wires the mocked prisma and services for one scenario
function setup({ link, rows = [standingRow()], targets = [], results = [], standings = [], contact = null, season = SEASON, config = {} } = {}) {
  const prisma = {
    trainerStudent: {
      findFirst: vi.fn().mockResolvedValue(
        link === undefined
          ? { student: { firstName: 'João', lastName: 'Vieira', username: null, socials: { whatsapp: '+5511999990000' } } }
          : link,
      ),
    },
    consistencyWeeklyResult: { findMany: vi.fn().mockResolvedValue(results) },
    consistencySeasonStanding: { findMany: vi.fn().mockResolvedValue(standings) },
    consistencyContactLog: { findFirst: vi.fn().mockResolvedValue(contact) },
    consistencyWeeklyTarget: { findMany: vi.fn().mockResolvedValue(targets) },
  };
  getPanelStandings.mockResolvedValue({ season: null, rows, entering: [] });
  getConfig.mockResolvedValue(config);
  ensureCurrentSeason.mockResolvedValue(season);
  return prisma;
}

describe('getStudentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PAN-51 answers 404 for a student that is not linked to the trainer', async () => {
    const prisma = setup({ link: null });

    const error = await getStudentPanel(prisma, TRAINER_ID, 'stranger', NOW).catch((caught) => caught);

    expect(error).toMatchObject({ httpStatus: 404, messageCode: 'student.notFound' });
    expect(prisma.trainerStudent.findFirst.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID, studentId: 'stranger' });
    expect(getPanelStandings).not.toHaveBeenCalled();
    expect(prisma.consistencyContactLog.findFirst).not.toHaveBeenCalled();
  });

  it('PAN-33 returns the frozen and adjusted target of the running week per pillar', async () => {
    const targets = [
      { pillar: Pillar.WORKOUTS, expected: 4, adjusted: 2 },
      { pillar: Pillar.CARDIO, expected: 3, adjusted: null },
    ];
    const prisma = setup({ targets });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.currentTargets).toEqual(targets);
    expect(materializeTargets).toHaveBeenCalledWith(prisma, TRAINER_ID, { year: 2026, month: 11, day: 9 }, [STUDENT_ID]);
    expect(prisma.consistencyWeeklyTarget.findMany.mock.calls[0][0].where).toEqual({
      trainerId: TRAINER_ID,
      studentId: STUDENT_ID,
      weekStart: new Date(Date.UTC(2026, 10, 9)),
    });
  });

  it('PAN-20 returns the risk with the scores of the weeks that caused it', async () => {
    const prisma = setup();

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.risk).toEqual(RISK);
  });

  it('PAN-21 returns closed weeks with score, the running week with its partial and future weeks empty', async () => {
    const results = [
      storedResult('2026-10-26', WeekStatus.VALID, 64),
      storedResult('2026-11-02', WeekStatus.VALID, 58),
    ];
    const prisma = setup({ results });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.weeks).toEqual([
      { weekStart: '2026-10-26', number: 1, state: 'closed', status: WeekStatus.VALID, score: 64 },
      { weekStart: '2026-11-02', number: 2, state: 'closed', status: WeekStatus.VALID, score: 58 },
      { weekStart: '2026-11-09', number: 3, state: 'current', status: WeekStatus.VALID, score: 40 },
      { weekStart: '2026-11-16', number: 4, state: 'future', status: null, score: null },
    ]);
    expect(prisma.consistencyWeeklyResult.findMany.mock.calls[0][0].where).toEqual({
      trainerId: TRAINER_ID,
      studentId: STUDENT_ID,
      seasonId: 's1',
    });
  });

  it('PAN-21 shows paused and missing closed weeks without a score', async () => {
    const prisma = setup({ results: [storedResult('2026-11-02', WeekStatus.PAUSED, null)] });

    const { weeks } = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(weeks[0]).toMatchObject({ number: 1, state: 'closed', status: WeekStatus.NEUTRAL, score: null });
    expect(weeks[1]).toMatchObject({ number: 2, state: 'closed', status: WeekStatus.PAUSED, score: null });
  });

  it('PAN-21 returns the risk limit of the config for the dashed line', async () => {
    const withDefault = await getStudentPanel(setup(), TRAINER_ID, STUDENT_ID, NOW);
    const withConfig = await getStudentPanel(setup({ config: { riskLimit: 60 } }), TRAINER_ID, STUDENT_ID, NOW);

    expect([withDefault.riskLimit, withConfig.riskLimit]).toEqual([70, 60]);
  });

  it('PAN-22 returns the season pillars and the weakest one with the first name and whatsapp', async () => {
    const prisma = setup();

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.seasonPillars).toEqual(SEASON_PILLARS);
    expect(panel.weakestPillar).toBe(Pillar.CARDIO);
    expect(panel.firstName).toBe('João');
    expect(panel.whatsapp).toBe('+5511999990000');
  });

  it('PAN-22 has no weakest pillar and no whatsapp when the student has neither', async () => {
    const link = { student: { firstName: 'Ana', lastName: null, username: null, socials: null } };
    const prisma = setup({ link, rows: [standingRow({ seasonPillars: [] })] });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.weakestPillar).toBeNull();
    expect(panel.whatsapp).toBeNull();
  });

  it('PAN-19 returns the position among the ranked students, the average and the band', async () => {
    const others = [standingRow({ studentId: 'a', position: 1 }), standingRow(), standingRow({ studentId: 'c', position: 3 })];
    const prisma = setup({ rows: others });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel).toMatchObject({ studentId: STUDENT_ID, position: 2, total: 3, average: 61, faixa: Faixa.RESTARTING, displayName: 'João V.' });
  });

  it('PAN-19 describes a student with no valid week as entering without a position', async () => {
    const prisma = setup({ rows: [standingRow({ studentId: 'other' })] });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel).toMatchObject({ position: null, total: 1, average: null, faixa: Faixa.ENTERING, risk: null, seasonPillars: [] });
  });

  it('PAN-26 returns the average and band of each previous season, newest first, and the last contact', async () => {
    const contactAt = new Date('2026-11-05T13:00:00Z');
    const standings = [
      storedStanding(1, '2026-08-03', '60'),
      storedStanding(2, '2026-09-28', '90'),
      storedStanding(0, '2026-07-06', '95', false),
    ];
    const prisma = setup({ standings, contact: { createdAt: contactAt } });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.previousSeasons).toEqual([
      { number: 2, startWeek: '2026-09-28', endWeek: '2026-10-19', average: 90, faixa: Faixa.CONSTANT },
      { number: 1, startWeek: '2026-08-03', endWeek: '2026-08-24', average: 60, faixa: Faixa.RESTARTING },
      { number: 0, startWeek: '2026-07-06', endWeek: '2026-07-27', average: 95, faixa: Faixa.ENTERING },
    ]);
    expect(panel.lastContact).toEqual(contactAt);
    expect(prisma.consistencySeasonStanding.findMany.mock.calls[0][0].where).toMatchObject({ trainerId: TRAINER_ID, studentId: STUDENT_ID });
  });

  it('PAN-26 returns no last contact for a student never contacted', async () => {
    const prisma = setup({ contact: null });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.lastContact).toBeNull();
    expect(panel.previousSeasons).toEqual([]);
  });

  it('PAN-21 returns no weeks when the trainer has no season', async () => {
    const prisma = setup({ season: null });

    const panel = await getStudentPanel(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(panel.weeks).toEqual([]);
    expect(prisma.consistencyWeeklyResult.findMany).not.toHaveBeenCalled();
  });
});

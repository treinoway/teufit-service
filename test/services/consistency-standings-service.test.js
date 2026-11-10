import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getPanelStandings, getStandings } from '../../src/services/consistency-standings-service.js';
import { getConfig, ruleForWeek } from '../../src/services/consistency-config-service.js';
import { ensureCurrentSeason } from '../../src/services/consistency-season-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone, listSessions } from '../../src/services/consistency-progress-service.js';
import { pauseReasonsFor, pausesFor } from '../../src/services/consistency-pause-service.js';
import {
  ConsistencyErrorCode,
  ConsistencyMessageCode,
  Faixa,
  SeasonStatus,
  SignalType,
  StandingsFilter,
  WeekStatus,
} from '../../src/constants/consistency-ranking.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn(), ruleForWeek: vi.fn() }));
vi.mock('../../src/services/consistency-season-service.js', () => ({ ensureCurrentSeason: vi.fn() }));
vi.mock('../../src/services/consistency-target-service.js', () => ({ materializeTargets: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', () => ({ countDone: vi.fn(), listSessions: vi.fn() }));
vi.mock('../../src/services/consistency-pause-service.js', () => ({ pausesFor: vi.fn(), pauseReasonsFor: vi.fn() }));

const { Decimal } = Prisma;
const TRAINER_ID = 'trainer-1';
// Wednesday 2026-11-11 12:00 in Sao Paulo; the running week starts Monday 2026-11-09 (week 3 of the season)
const NOW = new Date('2026-11-11T15:00:00Z');
const WEEK_MS = 7 * 86400000;
const LAST_CLOSED_MONDAY = Date.UTC(2026, 10, 2);
const OLD_LINK = new Date('2026-01-01T00:00:00Z');
const RULE = {
  weights: { workouts: 30, diet: 30, cardio: 15, feedback: 15, hydration: 10 },
  activePillars: ['workouts', 'cardio', 'feedback', 'hydration'],
  closeWeekday: 0,
  closeHour: 21,
  timeZone: 'America/Sao_Paulo',
};
const CONFIG = { ...RULE, seasonWeeks: 4, minPodiumWeeks: 2 };
const SEASON = {
  id: 's1',
  trainerId: TRAINER_ID,
  number: 1,
  startWeek: new Date(Date.UTC(2026, 9, 26)),
  weeks: 4,
  status: SeasonStatus.ACTIVE,
};

// Stored closed weeks of a student, most recent first, ending the Monday before the running week
function history(studentId, entries) {
  return entries.map(([seasonId, status, score], index) => ({
    studentId,
    seasonId,
    status,
    score: score === null ? null : new Decimal(score),
    weekStart: new Date(LAST_CLOSED_MONDAY - index * WEEK_MS),
  }));
}

// Closed weeks at 100: `inSeason` of this season followed by `before` of an earlier one
function perfect(studentId, inSeason, before) {
  const entries = [
    ...Array.from({ length: inSeason }, () => ['s1', WeekStatus.VALID, 100]),
    ...Array.from({ length: before }, () => ['s0', WeekStatus.VALID, 100]),
  ];
  return history(studentId, entries);
}

// Active link of a student with a display name
function link(studentId, firstName, overrides = {}) {
  return { studentId, activeOnPlan: true, createdAt: OLD_LINK, student: { firstName, lastName: null, username: null }, ...overrides };
}

// Wires the mocked prisma and dependent services for one scenario
function setup({
  links = [],
  results = [],
  targets = {},
  done = {},
  team = false,
  studentPauses = {},
  season = SEASON,
  sessions = [],
  pauseReasons = {},
  config = CONFIG,
} = {}) {
  const prisma = {
    trainerStudent: {
      findMany: vi.fn(async ({ where }) => links.filter((row) => row.activeOnPlan === where.activeOnPlan)),
    },
    consistencyWeeklyResult: {
      findMany: vi.fn(async ({ where }) =>
        results
          .filter((row) => where.studentId.in.includes(row.studentId))
          .sort((a, b) => b.weekStart - a.weekStart),
      ),
    },
    consistencySeason: { findFirst: vi.fn() },
    consistencySeasonStanding: { findMany: vi.fn() },
  };
  const active = links.filter((row) => row.activeOnPlan);
  getConfig.mockResolvedValue(config);
  ruleForWeek.mockResolvedValue(RULE);
  ensureCurrentSeason.mockResolvedValue(season);
  materializeTargets.mockImplementation(async (_p, _t, _w, ids) =>
    new Map(ids.map((id) => [id, targets[id] ?? { workouts: 3, cardio: 0 }])),
  );
  countDone.mockImplementation(async (_p, _t, ids) =>
    new Map(ids.map((id) => [id, done[id] ?? { workouts: 3, cardio: 0 }])),
  );
  pausesFor.mockResolvedValue(
    new Map([['2026-11-09', { team, students: new Map(Object.entries(studentPauses)) }]]),
  );
  listSessions.mockResolvedValue(sessions);
  pauseReasonsFor.mockResolvedValue({
    team: pauseReasons.team ?? null,
    students: new Map(Object.entries(pauseReasons.students ?? {})),
  });
  return { prisma, active };
}

describe('getStandings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ranks the spec example: Camila 92.6 with partial, ties share positions', async () => {
    const links = [link('ana', 'Ana'), link('bruno', 'Bruno'), link('lucas', 'Lucas'), link('paula', 'Paula'), link('camila', 'Camila')];
    const results = [
      ...perfect('ana', 2, 7),
      ...perfect('bruno', 2, 3),
      ...perfect('lucas', 2, 3),
      ...history('paula', [['s1', WeekStatus.VALID, 98], ['s1', WeekStatus.VALID, 98]]),
      ...history('camila', [['s1', WeekStatus.VALID, 85.2], ['s1', WeekStatus.VALID, 100]]),
    ];
    const { prisma } = setup({
      links,
      results,
      done: { paula: { workouts: 0, cardio: 0 }, camila: { workouts: 1, cardio: 0 } },
    });

    const { season, rows, entering } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(season).toEqual({ number: 1, startWeek: '2026-10-26', endWeek: '2026-11-16', weeks: 4, currentWeek: 3, status: 'active' });
    expect(entering).toEqual([]);
    expect(rows.map((row) => [row.name, row.position])).toEqual([
      ['Ana', 1],
      ['Bruno', 2],
      ['Lucas', 2],
      ['Paula', 4],
      ['Camila', 5],
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect([byName.Ana.streak, byName.Bruno.streak, byName.Lucas.streak]).toEqual([9, 5, 5]);
    expect(byName.Ana.weeksAt100).toBe(2);
    expect(byName.Paula.average.toString()).toBe('98');
    expect(byName.Camila.average.toString()).toBe('92.6');
    expect(byName.Camila.partialScore.toString()).toBe('33.3333');
    expect(byName.Camila.validWeeks).toBe(3);
    expect(byName.Camila.pillars).toEqual({ workouts: { expected: 3, done: 1 }, cardio: { expected: 0, done: 0 } });
  });

  it('reads the done window from the previous close to this close (AD-006)', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0) });

    await getStandings(prisma, TRAINER_ID, { now: NOW });

    const window = countDone.mock.calls[0][3];
    expect(window.from.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  it('RANK-08 marks the joining week neutral', async () => {
    const joiner = link('joiner', 'Joiner', { createdAt: new Date('2026-11-10T12:00:00Z') });
    const { prisma } = setup({
      links: [joiner],
      results: history('joiner', [['s1', WeekStatus.VALID, 100], ['s1', WeekStatus.VALID, 80]]),
    });

    const { rows } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weekStatus: WeekStatus.NEUTRAL, partialScore: null, validWeeks: 2, eligible: true });
    expect(rows[0].average.toString()).toBe('90');
  });

  it('RANK-24 lists not-yet-eligible students as entering', async () => {
    const links = [link('ana', 'Ana'), link('newbie', 'Newbie')];
    const results = [...perfect('ana', 2, 0), ...history('newbie', [['s1', WeekStatus.VALID, 100]])];
    const { prisma } = setup({ links, results, targets: { newbie: { workouts: 0, cardio: 0 } } });

    const { rows, entering } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows.map((row) => row.name)).toEqual(['Ana']);
    expect(entering).toEqual([{ studentId: 'newbie', name: 'Newbie', validWeeks: 1, weeksMissing: 1 }]);
  });

  it('RANK-25 omits students with no valid week', async () => {
    const links = [link('ana', 'Ana'), link('paused', 'Paused'), link('notarget', 'NoTarget')];
    const { prisma } = setup({
      links,
      results: perfect('ana', 2, 0),
      targets: { notarget: { workouts: 0, cardio: 0 } },
      studentPauses: { paused: true },
    });

    const { rows, entering } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows.map((row) => row.name)).toEqual(['Ana']);
    expect(entering).toEqual([]);
  });

  it('RANK-26 drops inactive students from the list', async () => {
    const links = [link('ana', 'Ana'), link('blocked', 'Blocked', { activeOnPlan: false })];
    const results = [...perfect('ana', 2, 0), ...perfect('blocked', 2, 0)];
    const { prisma } = setup({ links, results });

    const { rows } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows.map((row) => row.name)).toEqual(['Ana']);
    expect(prisma.trainerStudent.findMany.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID, activeOnPlan: true });
    expect(prisma.consistencyWeeklyResult.findMany.mock.calls[0][0].where.studentId.in).toEqual(['ana']);
    expect(results).toHaveLength(4);
  });

  it('RANK-51 treats inactive weeks as neutral', async () => {
    const gap = [{ ...perfect('back', 1, 0)[0], weekStart: new Date(Date.UTC(2026, 9, 26)) }];
    const { prisma } = setup({ links: [link('back', 'Back')], results: gap });

    const { rows } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0]).toMatchObject({ validWeeks: 2, weeksAt100: 1, eligible: true });
    expect(rows[0].average.toString()).toBe('100');
  });

  it('RANK-52 returns an empty list for a trainer without students', async () => {
    const { prisma } = setup({ links: [] });

    const result = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.season).toMatchObject({ number: 1, currentWeek: 3 });
    expect(result.rows).toEqual([]);
    expect(result.entering).toEqual([]);
    expect(materializeTargets).not.toHaveBeenCalled();
  });

  it('RANK-55 treats the relink week as neutral', async () => {
    const relinked = link('relinked', 'Relinked', { createdAt: new Date('2026-11-10T09:00:00Z') });
    const results = [{ ...perfect('relinked', 1, 0)[0], weekStart: new Date(Date.UTC(2026, 9, 26)) }];
    const { prisma } = setup({ links: [relinked], results });

    const { rows, entering } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows).toEqual([]);
    expect(entering).toEqual([{ studentId: 'relinked', name: 'Relinked', validWeeks: 1, weeksMissing: 1 }]);
  });

  it('excludes paused weeks from average and streak', async () => {
    const results = history('ana', [
      ['s1', WeekStatus.PAUSED, null],
      ['s1', WeekStatus.VALID, 100],
      ['s0', WeekStatus.VALID, 100],
      ['s0', WeekStatus.NEUTRAL, null],
      ['s0', WeekStatus.VALID, 100],
    ]);
    const { prisma } = setup({ links: [link('ana', 'Ana')], results, team: true });

    const { rows, entering } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows).toEqual([]);
    expect(entering).toEqual([{ studentId: 'ana', name: 'Ana', validWeeks: 1, weeksMissing: 1 }]);
  });

  it('keeps the paused week out of the average and streak of an eligible student', async () => {
    const results = history('ana', [
      ['s1', WeekStatus.VALID, 100],
      ['s1', WeekStatus.VALID, 100],
      ['s0', WeekStatus.PAUSED, null],
      ['s0', WeekStatus.VALID, 100],
      ['s0', WeekStatus.NEUTRAL, null],
      ['s0', WeekStatus.VALID, 100],
    ]);
    const { prisma } = setup({ links: [link('ana', 'Ana')], results, studentPauses: { ana: true } });

    const { rows } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0]).toMatchObject({ weekStatus: WeekStatus.PAUSED, partialScore: null, validWeeks: 2, streak: 4 });
    expect(rows[0].average.toString()).toBe('100');
  });

  it('lets a reactivated student count inside a team pause', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0), team: true, studentPauses: { ana: false } });

    const { rows } = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].weekStatus).toBe(WeekStatus.VALID);
  });

  it('returns a null season with empty lists before launch', async () => {
    const { prisma } = setup({ season: null });

    const result = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result).toEqual({ season: null, rows: [], entering: [] });
  });

  it('RANK-30 returns the frozen standings of a closed season', async () => {
    const closed = { ...SEASON, id: 's0', number: 1, status: SeasonStatus.CLOSED };
    const { prisma } = setup();
    prisma.consistencySeason.findFirst.mockResolvedValue(closed);
    prisma.consistencySeasonStanding.findMany.mockResolvedValue([
      { studentId: 'ana', position: 1, eligible: true, average: new Decimal('97.5'), validWeeks: 4, weeks100: 2, streak: 2, student: { firstName: 'Ana', lastName: 'Lima' } },
      { studentId: 'new', position: null, eligible: false, average: new Decimal('50'), validWeeks: 1, weeks100: 0, streak: 0, student: { firstName: 'Novo', lastName: null } },
    ]);

    const result = await getStandings(prisma, TRAINER_ID, { seasonNumber: 1, now: NOW });

    expect(result.season).toMatchObject({ number: 1, status: 'closed', currentWeek: 4 });
    expect(result.rows).toEqual([
      { studentId: 'ana', name: 'Ana Lima', position: 1, eligible: true, average: new Decimal('97.5'), validWeeks: 4, weeksAt100: 2, streak: 2 },
    ]);
    expect(result.entering).toEqual([{ studentId: 'new', name: 'Novo', validWeeks: 1, weeksMissing: 1 }]);
    expect(prisma.consistencySeasonStanding.findMany.mock.calls[0][0].where).toEqual({ seasonId: 's0' });
    expect(materializeTargets).not.toHaveBeenCalled();
  });

  it('RANK-23 lists tied frozen students alphabetically', async () => {
    const closed = { ...SEASON, id: 's0', number: 1, status: SeasonStatus.CLOSED };
    const { prisma } = setup();
    prisma.consistencySeason.findFirst.mockResolvedValue(closed);
    const tied = (studentId, firstName) => ({ studentId, position: 1, eligible: true, average: new Decimal('90'), validWeeks: 4, weeks100: 1, streak: 1, student: { firstName, lastName: null } });
    prisma.consistencySeasonStanding.findMany.mockResolvedValue([tied('zed', 'Zed'), tied('mia', 'Mia'), tied('ana', 'Ana')]);

    const { rows } = await getStandings(prisma, TRAINER_ID, { seasonNumber: 1, now: NOW });

    expect(rows.map((row) => row.name)).toEqual(['Ana', 'Mia', 'Zed']);
  });

  it('computes the active season live when its number is requested', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0) });
    prisma.consistencySeason.findFirst.mockResolvedValue(SEASON);

    const { rows } = await getStandings(prisma, TRAINER_ID, { seasonNumber: 1, now: NOW });

    expect(rows[0].name).toBe('Ana');
    expect(prisma.consistencySeasonStanding.findMany).not.toHaveBeenCalled();
  });

  it('throws 404 for an unknown season number', async () => {
    const { prisma } = setup();
    prisma.consistencySeason.findFirst.mockResolvedValue(null);

    await expect(getStandings(prisma, TRAINER_ID, { seasonNumber: 9, now: NOW })).rejects.toMatchObject({
      httpStatus: 404,
      error: ConsistencyErrorCode.SEASON_NOT_FOUND,
      messageCode: ConsistencyMessageCode.SEASON_NOT_FOUND,
    });
  });
});

const PANEL_CLOSE_LAST = new Date('2026-11-09T00:00:00Z');
const PANEL_CLOSE_CURRENT = new Date('2026-11-16T00:00:00Z');
const PANEL_WINDOW = { from: new Date('2026-11-02T00:00:00Z'), to: PANEL_CLOSE_CURRENT };
const NO_COUNTS_SUMMARY = { teamAverage: null, lastClosedWeekAverage: null, fullLastWeek: 0, validLastWeek: 0, atRisk: 0, withSignal: 0 };

// Closed weeks of a student with the pillar counts stored at the close, most recent score first
function closedWeeks(studentId, scores, pillars) {
  return history(
    studentId,
    scores.map((score) => ['s1', WeekStatus.VALID, score]),
  ).map((row) => ({ ...row, pillars }));
}

// A student whose last two closed weeks (64 then 58) put them at risk, with the running week at zero
function riskyStudent() {
  const pillars = { workouts: { expected: 3, done: 1 }, cardio: { expected: 2, done: 0 } };
  return {
    links: [link('joao', 'João', { student: { firstName: 'João', lastName: 'Vieira', username: null } })],
    results: [...closedWeeks('joao', [58, 64], pillars), { ...perfect('joao', 1, 0)[0], seasonId: 's0', weekStart: new Date(Date.UTC(2026, 9, 19)) }],
    done: { joao: { workouts: 0, cardio: 0 } },
  };
}

// Completed session finishing at the instant
function sessionAt(studentId, id, finishedAt, durationSeconds = 3600) {
  return { id, studentId, finishedAt: new Date(finishedAt), durationSeconds };
}

describe('getPanelStandings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PAN-46 returns band, season pillars, risk and short name per student', async () => {
    const { links, results, done } = riskyStudent();
    const { prisma } = setup({ links, results, done });

    const { rows, entering } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(entering).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      studentId: 'joao',
      displayName: 'João V.',
      initials: 'JV',
      position: 1,
      faixa: Faixa.RESTARTING,
      average: 61,
      currentWeekScore: 0,
      weeks100: 0,
      risk: { weeks: 2, scores: [64, 58] },
      pause: null,
      entering: null,
      signals: [],
    });
    expect(rows[0].seasonPillars).toEqual([
      { pillar: 'workouts', done: 2, expected: 6, adherence: 33.3333 },
      { pillar: 'cardio', done: 0, expected: 4, adherence: 0 },
    ]);
  });

  it('PAN-46 uses the first name alone when there is no last name', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0) });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0]).toMatchObject({ displayName: 'Ana', initials: 'A', faixa: Faixa.FULL, average: 100 });
  });

  it('PAN-46 takes the initial of the last word of a compound last name', async () => {
    const compound = link('ana', 'Ana', { student: { firstName: 'Ana', lastName: 'Lima de Souza', username: null } });
    const { prisma } = setup({ links: [compound], results: perfect('ana', 2, 0) });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0]).toMatchObject({ displayName: 'Ana S.', initials: 'AS' });
  });

  it('PAN-46 returns the pause of the running week with its reason', async () => {
    const { prisma } = setup({
      links: [link('marcos', 'Marcos')],
      results: perfect('marcos', 2, 0),
      studentPauses: { marcos: true },
      pauseReasons: { students: { marcos: 'viagem' } },
    });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].pause).toEqual({ weekStart: '2026-11-09', reason: 'viagem' });
    expect(rows[0].currentWeekScore).toBeNull();
  });

  it('PAN-08 returns the closed paused week of the season with its reason and keeps pause empty', async () => {
    const results = [...history('marcos', [['s1', WeekStatus.VALID, 100], ['s1', WeekStatus.PAUSED, null]])];
    const { prisma } = setup({ links: [link('marcos', 'Marcos'), link('ana', 'Ana')], results: [...results, ...perfect('ana', 2, 0)] });
    pauseReasonsFor.mockImplementation(async (_p, _t, week) => ({
      team: null,
      students: new Map(week.day === 26 ? [['marcos', 'viagem']] : []),
    }));

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });
    const marcos = rows.find((row) => row.studentId === 'marcos');
    const ana = rows.find((row) => row.studentId === 'ana');

    expect(marcos.pause).toBeNull();
    expect(marcos.closedPause).toEqual({ weekStart: '2026-10-26', reason: 'viagem' });
    expect(ana.closedPause).toBeNull();
  });

  it('PAN-08 ignores a paused week of an earlier season', async () => {
    const { prisma } = setup({ links: [link('marcos', 'Marcos')], results: history('marcos', [['s1', WeekStatus.VALID, 100], ['s0', WeekStatus.PAUSED, null]]) });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].closedPause).toBeNull();
  });

  it('PAN-46 gives a team pause its reason', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0), team: true, pauseReasons: { team: 'feriado' } });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].pause).toEqual({ weekStart: '2026-11-09', reason: 'feriado' });
  });

  it('PAN-46 lists students still entering with their progress and no position', async () => {
    const links = [link('ana', 'Ana'), link('newbie', 'Newbie')];
    const results = [...perfect('ana', 2, 0), ...history('newbie', [['s1', WeekStatus.VALID, 100]])];
    const { prisma } = setup({ links, results, targets: { newbie: { workouts: 0, cardio: 0 } } });

    const { rows, entering } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows.map((row) => row.displayName)).toEqual(['Ana']);
    expect(entering).toHaveLength(1);
    expect(entering[0]).toMatchObject({
      studentId: 'newbie',
      position: null,
      faixa: Faixa.ENTERING,
      entering: { validWeeks: 1, required: 2 },
    });
  });

  it('PAN-46 applies the panel rule defaults when the config carries none', async () => {
    const { links, results, done } = riskyStudent();
    const { prisma } = setup({ links, results, done, config: CONFIG });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].risk).not.toBeNull();
  });

  it('PAN-46 follows the risk rule of the config', async () => {
    const { links, results, done } = riskyStudent();
    const { prisma } = setup({ links, results, done, config: { ...CONFIG, riskLimit: 60, riskWeeks: 2 } });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].risk).toBeNull();
  });

  it('PAN-46 returns the season with the close instant of the running week', async () => {
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0) });

    const { season } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(season).toEqual({
      number: 1,
      startWeek: '2026-10-26',
      endWeek: '2026-11-16',
      weeks: 4,
      currentWeek: 3,
      status: 'active',
      closesAt: PANEL_CLOSE_CURRENT,
    });
  });

  it('PAN-47 returns the filter counts and the four summary numbers', async () => {
    const { links, results, done } = riskyStudent();
    const { prisma } = setup({ links: [...links, link('ana', 'Ana')], results: [...results, ...perfect('ana', 2, 0)], done });

    const { counts, summary } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(counts).toEqual({ all: 2, risk: 1, signal: 0, entering: 0, paused: 0 });
    expect(summary).toEqual({
      teamAverage: 80.5,
      lastClosedWeekAverage: 79,
      fullLastWeek: 1,
      validLastWeek: 2,
      atRisk: 1,
      withSignal: 0,
    });
  });

  it('PAN-47 filters at-risk students and orders them by ascending average', async () => {
    const pillars = { workouts: { expected: 3, done: 0 } };
    const links = [link('a', 'Alice'), link('b', 'Bruno'), link('c', 'Carla')];
    const results = [...closedWeeks('a', [50, 55], pillars), ...closedWeeks('b', [30, 40], pillars), ...perfect('c', 2, 0)];
    const zero = { workouts: 0, cardio: 0 };
    const { prisma } = setup({ links, results, done: { a: zero, b: zero } });

    const result = await getPanelStandings(prisma, TRAINER_ID, { filter: StandingsFilter.RISK, now: NOW });

    expect(result.rows.map((row) => row.displayName)).toEqual(['Bruno', 'Alice']);
    expect(result.counts.all).toBe(3);
  });

  it('PAN-47 searches by name ignoring accents while the counts stay global', async () => {
    const links = [link('j', 'João'), link('a', 'Ana')];
    const { prisma } = setup({ links, results: [...perfect('j', 2, 0), ...perfect('a', 2, 0)] });

    const result = await getPanelStandings(prisma, TRAINER_ID, { q: 'joao', now: NOW });

    expect(result.rows.map((row) => row.displayName)).toEqual(['João']);
    expect(result.counts.all).toBe(2);
  });

  it('PAN-48 flags a quick completion of the running week', async () => {
    const quick = sessionAt('ana', 'quick', '2026-11-10T12:00:00Z', 240);
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0), sessions: [quick] });

    const { rows, counts, summary } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].signals).toEqual([
      { type: SignalType.QUICK_COMPLETION, sessionId: 'quick', finishedAt: quick.finishedAt, durationSeconds: 240 },
    ]);
    expect(counts.signal).toBe(1);
    expect(summary.withSignal).toBe(1);
    expect(listSessions).toHaveBeenCalledWith(prisma, TRAINER_ID, ['ana'], PANEL_WINDOW);
  });

  it('PAN-48 keeps the signal of the last closed week and drops older sessions', async () => {
    const lastWeek = sessionAt('ana', 'last', '2026-11-05T12:00:00Z', 60);
    const tooOld = sessionAt('ana', 'old', '2026-11-01T12:00:00Z', 60);
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0), sessions: [lastWeek, tooOld] });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].signals.map((signal) => signal.sessionId)).toEqual(['last']);
  });

  it('PAN-49 flags batch logging in the minutes before the last close', async () => {
    const batch = [59, 55, 50, 45, 40].map((minute) => sessionAt('ana', `b${minute}`, `2026-11-08T23:${minute}:00Z`));
    const { prisma } = setup({ links: [link('ana', 'Ana')], results: perfect('ana', 2, 0), sessions: batch });

    const { rows } = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(rows[0].signals).toEqual([{ type: SignalType.BATCH_LOGGING, count: 5, closeInstant: PANEL_CLOSE_LAST }]);
  });

  it('PAN-52 leaves average, week score, position and band unchanged for a student with a signal', async () => {
    const results = [...perfect('ana', 2, 0), ...perfect('bia', 2, 0)];
    const links = [link('ana', 'Ana'), link('bia', 'Bia')];
    const quick = sessionAt('ana', 'quick', '2026-11-10T12:00:00Z', 60);
    const baseline = await getPanelStandings(setup({ links, results }).prisma, TRAINER_ID, { now: NOW });

    const flagged = await getPanelStandings(setup({ links, results, sessions: [quick] }).prisma, TRAINER_ID, { now: NOW });

    const pick = ({ average, currentWeekScore, position, faixa }) => ({ average, currentWeekScore, position, faixa });
    expect(flagged.rows[0].signals).toHaveLength(1);
    expect(flagged.rows.map(pick)).toEqual(baseline.rows.map(pick));
  });

  it('PAN-46 returns empty lists and no averages for a trainer without students', async () => {
    const { prisma } = setup({ links: [] });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.rows).toEqual([]);
    expect(result.entering).toEqual([]);
    expect(result.counts).toEqual({ all: 0, risk: 0, signal: 0, entering: 0, paused: 0 });
    expect(result.summary).toEqual(NO_COUNTS_SUMMARY);
    expect(result.season).toMatchObject({ number: 1, currentWeek: 3 });
  });

  it('PAN-46 returns a null season with empty lists before launch', async () => {
    const { prisma } = setup({ season: null });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.season).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.counts.all).toBe(0);
  });

  it('PAN-46 gives the frozen standings of a closed season the band and short name', async () => {
    const closed = { ...SEASON, id: 's0', number: 1, status: SeasonStatus.CLOSED };
    const { prisma } = setup();
    prisma.consistencySeason.findFirst.mockResolvedValue(closed);
    prisma.consistencySeasonStanding.findMany.mockResolvedValue([
      { studentId: 'ana', position: 1, eligible: true, average: new Decimal('97.5'), validWeeks: 4, weeks100: 2, streak: 2, student: { firstName: 'Ana', lastName: 'Lima' } },
      { studentId: 'new', position: null, eligible: false, average: new Decimal('50'), validWeeks: 1, weeks100: 0, streak: 0, student: { firstName: 'Novo', lastName: null } },
    ]);

    const result = await getPanelStandings(prisma, TRAINER_ID, { seasonNumber: 1, now: NOW });

    expect(result.season).toMatchObject({ number: 1, status: 'closed', closesAt: null });
    expect(result.rows[0]).toMatchObject({
      displayName: 'Ana L.',
      initials: 'AL',
      position: 1,
      faixa: Faixa.CONSTANT,
      average: 97.5,
      weeks100: 2,
      streak: 2,
      risk: null,
      signals: [],
      pause: null,
    });
    expect(result.entering[0]).toMatchObject({ displayName: 'Novo', position: null, faixa: Faixa.ENTERING, entering: { validWeeks: 1, required: 2 } });
    expect(result.counts).toMatchObject({ all: 2, entering: 1 });
  });
});

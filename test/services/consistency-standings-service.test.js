import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getStandings } from '../../src/services/consistency-standings-service.js';
import { getConfig, ruleForWeek } from '../../src/services/consistency-config-service.js';
import { ensureCurrentSeason } from '../../src/services/consistency-season-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { pausesFor } from '../../src/services/consistency-pause-service.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, SeasonStatus, WeekStatus } from '../../src/constants/consistency-ranking.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn(), ruleForWeek: vi.fn() }));
vi.mock('../../src/services/consistency-season-service.js', () => ({ ensureCurrentSeason: vi.fn() }));
vi.mock('../../src/services/consistency-target-service.js', () => ({ materializeTargets: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', () => ({ countDone: vi.fn() }));
vi.mock('../../src/services/consistency-pause-service.js', () => ({ pausesFor: vi.fn() }));

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
function setup({ links = [], results = [], targets = {}, done = {}, team = false, studentPauses = {}, season = SEASON } = {}) {
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
  getConfig.mockResolvedValue(CONFIG);
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

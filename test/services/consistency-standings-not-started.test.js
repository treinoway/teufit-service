import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPanelStandings, getStandings } from '../../src/services/consistency-standings-service.js';
import { SeasonStatus } from '../../src/constants/consistency-ranking.js';

const TRAINER_ID = 'trainer-1';
const LAUNCH_ENV = 'CONSISTENCY_RANKING_LAUNCH_WEEK';
// Wednesday 2026-11-11 12:00 in Sao Paulo (UTC-3); its Monday is 2026-11-09
const NOW = new Date('2026-11-11T15:00:00Z');
const RUNNING_MONDAY = '2026-11-09';
const NEXT_MONDAY = '2026-11-16';
const LAUNCH_PENDING = 'launchPending';
const NO_ACTIVE_STUDENT = 'noActiveStudent';
const BETWEEN_SEASONS = 'betweenSeasons';

// Prisma mock answering the reads that decide whether a season exists or can start
function createPrisma({ seasons = [], closes = [], activeStudents = 1 } = {}) {
  const matchesSeason = (row, where) =>
    row.trainerId === where.trainerId &&
    (where.status === undefined || row.status === where.status) &&
    (where.number === undefined || row.number === where.number);
  const matchesClose = (row, where) => !where?.weekStart?.gte || row.weekStart >= where.weekStart.gte;
  return {
    consistencyRankingConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    consistencyScoringRule: { findFirst: vi.fn().mockResolvedValue(null) },
    trainerStudent: {
      count: vi.fn().mockResolvedValue(activeStudents),
      findFirst: vi.fn().mockResolvedValue(activeStudents > 0 ? { studentId: 'student-1' } : null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    consistencyWeekClose: {
      findFirst: vi.fn(async ({ where } = {}) => {
        const matches = closes.filter((row) => matchesClose(row, where)).sort((a, b) => b.weekStart - a.weekStart);
        return matches[0] ?? null;
      }),
    },
    consistencySeason: {
      findFirst: vi.fn(async ({ where, orderBy } = {}) => {
        const matches = seasons.filter((row) => matchesSeason(row, where));
        if (orderBy?.number === 'desc') matches.sort((a, b) => b.number - a.number);
        return matches[0] ?? null;
      }),
      create: vi.fn(),
    },
  };
}

// Closed season row as stored
function closedSeason(overrides) {
  return {
    id: 'season-closed',
    trainerId: TRAINER_ID,
    number: 1,
    startWeek: new Date(Date.UTC(2026, 9, 19)),
    weeks: 4,
    status: SeasonStatus.CLOSED,
    closeRequestedAt: null,
    closedAt: new Date('2026-11-15T23:00:00Z'),
    ...overrides,
  };
}

describe('getPanelStandings notStarted', () => {
  beforeEach(() => {
    vi.stubEnv(LAUNCH_ENV, RUNNING_MONDAY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('PAN-60 says the launch is pending without a date when the launch week env is unset', async () => {
    vi.stubEnv(LAUNCH_ENV, '');
    const prisma = createPrisma();

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.season).toBeNull();
    expect(result.notStarted).toEqual({ reason: LAUNCH_PENDING, startsOn: null });
  });

  it('PAN-60 says the launch is pending without a date when the launch week env is not a valid date', async () => {
    vi.stubEnv(LAUNCH_ENV, 'soon');
    const prisma = createPrisma();

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.notStarted).toEqual({ reason: LAUNCH_PENDING, startsOn: null });
  });

  it('PAN-60 says the launch is pending with the launch Monday when the current week is before it', async () => {
    vi.stubEnv(LAUNCH_ENV, NEXT_MONDAY);
    const prisma = createPrisma();

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.season).toBeNull();
    expect(result.notStarted).toEqual({ reason: LAUNCH_PENDING, startsOn: NEXT_MONDAY });
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });

  it('PAN-60 uses the trainer timezone: Sunday night in Sao Paulo is still before the launch Monday', async () => {
    vi.stubEnv(LAUNCH_ENV, NEXT_MONDAY);
    const sundayNight = new Date('2026-11-16T01:00:00Z');
    const prisma = createPrisma();

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: sundayNight });

    expect(result.notStarted).toEqual({ reason: LAUNCH_PENDING, startsOn: NEXT_MONDAY });
  });

  it('PAN-60 says there is no active student once launched without an active-on-plan student', async () => {
    const prisma = createPrisma({ activeStudents: 0 });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.season).toBeNull();
    expect(result.notStarted).toEqual({ reason: NO_ACTIVE_STUDENT, startsOn: null });
  });

  it('PAN-60 puts launchPending before noActiveStudent', async () => {
    vi.stubEnv(LAUNCH_ENV, NEXT_MONDAY);
    const prisma = createPrisma({ activeStudents: 0 });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result.notStarted).toEqual({ reason: LAUNCH_PENDING, startsOn: NEXT_MONDAY });
  });

  it('PAN-60 says it is between seasons with the next Monday while the closing week still runs', async () => {
    const closes = [{ trainerId: TRAINER_ID, weekStart: new Date(Date.UTC(2026, 10, 9)) }];
    const prisma = createPrisma({ seasons: [closedSeason()], closes });
    const sundayAfterClose = new Date('2026-11-16T02:30:00Z');

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: sundayAfterClose });

    expect(result.season).toBeNull();
    expect(result.notStarted).toEqual({ reason: BETWEEN_SEASONS, startsOn: NEXT_MONDAY });
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });

  it('PAN-60 gives the Monday after the last closed week when an early close ended the season mid-week', async () => {
    vi.stubEnv(LAUNCH_ENV, '2030-01-07');
    const season = closedSeason({ startWeek: new Date(Date.UTC(2030, 0, 7)), weeks: 2, closedAt: new Date('2030-01-15T15:00:00Z') });
    const closes = [
      { trainerId: TRAINER_ID, weekStart: new Date(Date.UTC(2030, 0, 7)) },
      { trainerId: TRAINER_ID, weekStart: new Date(Date.UTC(2030, 0, 14)) },
    ];
    const prisma = createPrisma({ seasons: [season], closes });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: new Date('2030-01-15T15:00:00Z') });

    expect(result.notStarted).toEqual({ reason: BETWEEN_SEASONS, startsOn: '2030-01-21' });
  });

  it('PAN-60 puts noActiveStudent before betweenSeasons', async () => {
    const closes = [{ trainerId: TRAINER_ID, weekStart: new Date(Date.UTC(2026, 10, 9)) }];
    const prisma = createPrisma({ seasons: [closedSeason()], closes, activeStudents: 0 });

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: new Date('2026-11-16T02:30:00Z') });

    expect(result.notStarted).toEqual({ reason: NO_ACTIVE_STUDENT, startsOn: null });
  });

  it('PAN-60 keeps the rest of the empty panel payload when no season exists', async () => {
    vi.stubEnv(LAUNCH_ENV, '');
    const prisma = createPrisma();

    const result = await getPanelStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result).toMatchObject({ season: null, rows: [], entering: [] });
    expect(result.counts).toEqual({ all: 0, risk: 0, signal: 0, entering: 0, paused: 0 });
  });
});

describe('getStandings without a season', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('PAN-60 keeps the F1 payload unchanged: no notStarted field', async () => {
    vi.stubEnv(LAUNCH_ENV, '');
    const prisma = createPrisma();

    const result = await getStandings(prisma, TRAINER_ID, { now: NOW });

    expect(result).toEqual({ season: null, rows: [], entering: [] });
  });
});

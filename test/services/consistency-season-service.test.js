import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureCurrentSeason,
  listSeasons,
  requestEarlyClose,
} from '../../src/services/consistency-season-service.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, SeasonStatus } from '../../src/constants/consistency-ranking.js';

const TRAINER_ID = 'trainer-1';
const LAUNCH_ENV = 'CONSISTENCY_RANKING_LAUNCH_WEEK';
// Wednesday 2026-11-11 12:00 in Sao Paulo (UTC-3); its Monday is 2026-11-09
const NOW = new Date('2026-11-11T15:00:00Z');
const CURRENT_MONDAY = new Date(Date.UTC(2026, 10, 9));

// Builds a prisma mock backed by an in-memory list of seasons
function createPrisma({ seasons = [], closes = [], activeStudents = 1, configRow = null, ruleRow = null } = {}) {
  const store = seasons.map((row) => ({ ...row }));
  return {
    store,
    consistencyRankingConfig: { findUnique: vi.fn().mockResolvedValue(configRow) },
    consistencyScoringRule: { findFirst: vi.fn().mockResolvedValue(ruleRow) },
    trainerStudent: { count: vi.fn().mockResolvedValue(activeStudents) },
    consistencyWeekClose: {
      findFirst: vi.fn(async ({ where }) => {
        const matches = closes.filter((row) => row.weekStart >= where.weekStart.gte).sort((a, b) => b.weekStart - a.weekStart);
        return matches[0] ?? null;
      }),
    },
    consistencySeason: {
      findFirst: vi.fn(async ({ where, orderBy }) => {
        const matches = store.filter((row) => !where.status || row.status === where.status);
        if (orderBy?.number === 'desc') matches.sort((a, b) => b.number - a.number);
        return matches[0] ?? null;
      }),
      findMany: vi.fn(async ({ orderBy }) => {
        const copy = [...store];
        if (orderBy?.number === 'desc') copy.sort((a, b) => b.number - a.number);
        return copy;
      }),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `season-${store.length + 1}`,
          status: SeasonStatus.ACTIVE,
          closeRequestedAt: null,
          closedAt: null,
          ...data,
        };
        store.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => Object.assign(store.find((row) => row.id === where.id), data)),
    },
  };
}

// Season row as stored
function season(overrides) {
  return {
    id: 'season-x',
    trainerId: TRAINER_ID,
    number: 1,
    startWeek: new Date(Date.UTC(2026, 9, 12)),
    weeks: 4,
    status: SeasonStatus.ACTIVE,
    closeRequestedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe('ensureCurrentSeason', () => {
  beforeEach(() => {
    vi.stubEnv(LAUNCH_ENV, '2026-11-09');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('RANK-16 starts seasons on a Monday with the configured length', async () => {
    const prisma = createPrisma({ configRow: { seasonWeeks: 8 } });

    const created = await ensureCurrentSeason(prisma, TRAINER_ID, NOW);

    expect(created).toMatchObject({ trainerId: TRAINER_ID, number: 1, startWeek: CURRENT_MONDAY, weeks: 8 });
    expect(created.startWeek.getUTCDay()).toBe(1);
    expect(prisma.store).toHaveLength(1);
  });

  it('uses the default length when the trainer has no stored configuration', async () => {
    const prisma = createPrisma();

    const created = await ensureCurrentSeason(prisma, TRAINER_ID, NOW);

    expect(created.weeks).toBe(4);
  });

  it('returns null and creates nothing when the launch week env is unset', async () => {
    vi.stubEnv(LAUNCH_ENV, '');
    const prisma = createPrisma();

    expect(await ensureCurrentSeason(prisma, TRAINER_ID, NOW)).toBeNull();
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });

  it('returns null and creates nothing when the launch env is not a valid date', async () => {
    vi.stubEnv(LAUNCH_ENV, 'soon');
    const prisma = createPrisma();

    expect(await ensureCurrentSeason(prisma, TRAINER_ID, NOW)).toBeNull();
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });

  it('returns null before the launch week and starts on the launch week itself', async () => {
    vi.stubEnv(LAUNCH_ENV, '2026-11-16');
    const before = createPrisma();
    expect(await ensureCurrentSeason(before, TRAINER_ID, NOW)).toBeNull();
    expect(before.consistencySeason.create).not.toHaveBeenCalled();

    const launchMonday = new Date('2026-11-16T03:00:00Z');
    const onLaunch = createPrisma();
    const created = await ensureCurrentSeason(onLaunch, TRAINER_ID, launchMonday);
    expect(created.startWeek).toEqual(new Date(Date.UTC(2026, 10, 16)));
  });

  it('uses the trainer timezone: Sunday night in Sao Paulo is still the previous week', async () => {
    const sundayNight = new Date('2026-11-16T01:00:00Z');
    vi.stubEnv(LAUNCH_ENV, '2026-11-16');
    const beforeLaunch = createPrisma();
    expect(await ensureCurrentSeason(beforeLaunch, TRAINER_ID, sundayNight)).toBeNull();

    vi.stubEnv(LAUNCH_ENV, '2026-11-09');
    const afterLaunch = createPrisma();
    const created = await ensureCurrentSeason(afterLaunch, TRAINER_ID, sundayNight);
    expect(created.startWeek).toEqual(CURRENT_MONDAY);
  });

  it('returns null and creates nothing when the trainer has no active student', async () => {
    const prisma = createPrisma({ activeStudents: 0 });

    expect(await ensureCurrentSeason(prisma, TRAINER_ID, NOW)).toBeNull();
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
    expect(prisma.trainerStudent.count).toHaveBeenCalledWith({ where: { trainerId: TRAINER_ID, activeOnPlan: true } });
  });

  it('returns the existing active season without creating another', async () => {
    const active = season({ id: 'season-active', number: 3 });
    const prisma = createPrisma({ seasons: [active] });

    const result = await ensureCurrentSeason(prisma, TRAINER_ID, NOW);

    expect(result).toMatchObject({ id: 'season-active', number: 3 });
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
    expect(prisma.store).toHaveLength(1);
  });

  it('numbers the next season after the last closed one and uses the length in force now', async () => {
    const closed = season({ number: 2, status: SeasonStatus.CLOSED, closedAt: new Date('2026-11-02T03:00:00Z') });
    const older = season({ id: 'old', number: 1, status: SeasonStatus.CLOSED });
    const closes = [{ weekStart: new Date(Date.UTC(2026, 9, 26)) }];
    const prisma = createPrisma({ seasons: [closed, older], closes, configRow: { seasonWeeks: 12 } });

    const created = await ensureCurrentSeason(prisma, TRAINER_ID, NOW);

    expect(created).toMatchObject({ number: 3, startWeek: CURRENT_MONDAY, weeks: 12 });
  });

  it('does not open the next season before the Monday after the previous one closed', async () => {
    const closedSunday = season({ number: 1, status: SeasonStatus.CLOSED, closedAt: new Date('2026-11-15T23:00:00Z') });
    const closes = [{ weekStart: new Date(Date.UTC(2026, 10, 9)) }];
    const prisma = createPrisma({ seasons: [closedSunday], closes });
    const sundayAfterClose = new Date('2026-11-16T02:30:00Z');

    expect(await ensureCurrentSeason(prisma, TRAINER_ID, sundayAfterClose)).toBeNull();
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });

  it('RANK-17 opens the next season on the current Monday when the previous one closed late', async () => {
    vi.stubEnv(LAUNCH_ENV, '2030-01-07');
    const lateClose = season({
      number: 1,
      startWeek: new Date(Date.UTC(2030, 0, 7)),
      weeks: 1,
      status: SeasonStatus.CLOSED,
      closedAt: new Date('2030-01-15T15:00:00Z'),
    });
    const closes = [{ weekStart: new Date(Date.UTC(2030, 0, 7)) }];
    const prisma = createPrisma({ seasons: [lateClose], closes });

    const created = await ensureCurrentSeason(prisma, TRAINER_ID, new Date('2030-01-15T15:00:00Z'));

    expect(created).toMatchObject({ number: 2, startWeek: new Date(Date.UTC(2030, 0, 14)) });
  });

  it('never opens on a Monday that is not after the last closed week', async () => {
    vi.stubEnv(LAUNCH_ENV, '2030-01-07');
    const closed = season({ number: 1, startWeek: new Date(Date.UTC(2030, 0, 7)), weeks: 2, status: SeasonStatus.CLOSED, closedAt: new Date('2030-01-15T15:00:00Z') });
    const closes = [{ weekStart: new Date(Date.UTC(2030, 0, 7)) }, { weekStart: new Date(Date.UTC(2030, 0, 14)) }];
    const prisma = createPrisma({ seasons: [closed], closes });

    expect(await ensureCurrentSeason(prisma, TRAINER_ID, new Date('2030-01-15T15:00:00Z'))).toBeNull();
    expect(prisma.consistencySeason.create).not.toHaveBeenCalled();
  });
});

describe('requestEarlyClose', () => {
  it('RANK-45 ends the season at the next close', async () => {
    const active = season({ id: 'season-active', weeks: 8 });
    const prisma = createPrisma({ seasons: [active] });

    await requestEarlyClose(prisma, TRAINER_ID, NOW);

    const [stored] = prisma.store;
    expect(stored.closeRequestedAt).toEqual(NOW);
    expect(stored.status).toBe(SeasonStatus.ACTIVE);
    expect(stored.closedAt).toBeNull();
    expect(stored.weeks).toBe(8);
  });

  it('is idempotent: a second request keeps the first timestamp', async () => {
    const prisma = createPrisma({ seasons: [season()] });
    await requestEarlyClose(prisma, TRAINER_ID, NOW);

    const later = new Date(NOW.getTime() + 3600000);
    const result = await requestEarlyClose(prisma, TRAINER_ID, later);

    expect(result.closeRequestedAt).toEqual(NOW);
    expect(prisma.consistencySeason.update).toHaveBeenCalledTimes(1);
  });

  it('throws 404 SEASON_NOT_FOUND when there is no active season', async () => {
    const prisma = createPrisma({ seasons: [season({ status: SeasonStatus.CLOSED })] });

    await expect(requestEarlyClose(prisma, TRAINER_ID, NOW)).rejects.toMatchObject({
      httpStatus: 404,
      error: ConsistencyErrorCode.SEASON_NOT_FOUND,
      messageCode: ConsistencyMessageCode.SEASON_NOT_FOUND,
    });
    expect(prisma.consistencySeason.update).not.toHaveBeenCalled();
  });
});

describe('listSeasons', () => {
  it('lists the trainer seasons by number descending', async () => {
    const prisma = createPrisma({
      seasons: [season({ id: 'a', number: 1 }), season({ id: 'c', number: 3 }), season({ id: 'b', number: 2 })],
    });

    const result = await listSeasons(prisma, TRAINER_ID);

    expect(result.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(prisma.consistencySeason.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trainerId: TRAINER_ID }, orderBy: { number: 'desc' } }),
    );
  });
});

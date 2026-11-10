import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getGeneralHistory, listSeasonSummaries } from '../../src/services/consistency-history-service.js';
import { SeasonStatus, WeekStatus } from '../../src/constants/consistency-ranking.js';

const { Decimal } = Prisma;
const TRAINER_ID = 'trainer-1';
const WEEK_MS = 7 * 86400000;
const FIRST_MONDAY = Date.UTC(2026, 8, 7);

// Active link of a student with a name
function link(studentId, firstName, lastName = null) {
  return { studentId, student: { firstName, lastName, username: null } };
}

// Valid stored results of a student, oldest first
function validWeeks(studentId, scores) {
  return scores.map((score, index) => ({
    studentId,
    status: WeekStatus.VALID,
    score: new Decimal(score),
    weekStart: new Date(FIRST_MONDAY + index * WEEK_MS),
  }));
}

// Prisma mock that honours the studentId filter of the results query
function createPrisma({ links = [], results = [], seasons = [] } = {}) {
  return {
    trainerStudent: { findMany: vi.fn().mockResolvedValue(links) },
    consistencyWeeklyResult: {
      findMany: vi.fn(async ({ where }) => results.filter((row) => where.studentId.in.includes(row.studentId))),
    },
    consistencySeason: { findMany: vi.fn().mockResolvedValue(seasons) },
  };
}

describe('getGeneralHistory', () => {
  it('PAN-16 lists students with 4 or more valid weeks ordered by average', async () => {
    const prisma = createPrisma({
      links: [link('ana', 'Ana', 'Souza'), link('bruno', 'Bruno'), link('caio', 'Caio')],
      results: [...validWeeks('ana', [100, 100, 80, 100]), ...validWeeks('bruno', [100, 100, 100, 100, 95]), ...validWeeks('caio', [100, 100, 100])],
    });

    const { rows } = await getGeneralHistory(prisma, TRAINER_ID);

    expect(rows.map((row) => row.displayName)).toEqual(['Bruno', 'Ana S.']);
    expect(rows[0]).toMatchObject({ studentId: 'bruno', validWeeks: 5, average: 99, weeks100: 4, longestStreak: 4 });
    expect(rows[1]).toMatchObject({ studentId: 'ana', initials: 'AS', validWeeks: 4, average: 95, weeks100: 3, longestStreak: 2 });
  });

  it('PAN-16 reads only valid weeks of the active students of the trainer', async () => {
    const prisma = createPrisma({ links: [link('ana', 'Ana')], results: validWeeks('ana', [90, 90, 90, 90]) });

    await getGeneralHistory(prisma, TRAINER_ID);

    expect(prisma.trainerStudent.findMany.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID, activeOnPlan: true });
    expect(prisma.consistencyWeeklyResult.findMany.mock.calls[0][0].where).toEqual({
      trainerId: TRAINER_ID,
      studentId: { in: ['ana'] },
      status: WeekStatus.VALID,
    });
  });

  it('PAN-16 takes the longest run of weeks at 100 and breaks ties by weeks at 100 then name', async () => {
    const prisma = createPrisma({
      links: [link('zed', 'Zed'), link('amy', 'Amy'), link('run', 'Run')],
      results: [
        ...validWeeks('zed', [100, 100, 50, 100, 100, 100]),
        ...validWeeks('amy', [100, 100, 50, 100, 100, 100]),
        ...validWeeks('run', [100, 100, 100, 100, 100, 100]),
      ],
    });

    const { rows } = await getGeneralHistory(prisma, TRAINER_ID);

    expect(rows.map((row) => [row.displayName, row.longestStreak])).toEqual([['Run', 6], ['Amy', 3], ['Zed', 3]]);
  });

  it('PAN-16 returns an empty list without students', async () => {
    const prisma = createPrisma();

    expect(await getGeneralHistory(prisma, TRAINER_ID)).toEqual({ rows: [] });
    expect(prisma.consistencyWeeklyResult.findMany).not.toHaveBeenCalled();
  });
});

describe('listSeasonSummaries', () => {
  it('PAN-17 lists closed seasons with number, dates, participants and average, newest first', async () => {
    const prisma = createPrisma({
      seasons: [
        {
          number: 2,
          startWeek: new Date(Date.UTC(2026, 9, 5)),
          weeks: 4,
          standings: [{ eligible: true, average: new Decimal('90') }, { eligible: true, average: new Decimal('80') }, { eligible: false, average: new Decimal('10') }],
        },
        { number: 1, startWeek: new Date(Date.UTC(2026, 8, 7)), weeks: 4, standings: [] },
      ],
    });

    const seasons = await listSeasonSummaries(prisma, TRAINER_ID);

    expect(seasons).toEqual([
      { number: 2, startWeek: '2026-10-05', endWeek: '2026-10-26', weeks: 4, participants: 3, average: 85 },
      { number: 1, startWeek: '2026-09-07', endWeek: '2026-09-28', weeks: 4, participants: 0, average: null },
    ]);
    expect(prisma.consistencySeason.findMany.mock.calls[0][0]).toMatchObject({
      where: { trainerId: TRAINER_ID, status: SeasonStatus.CLOSED },
      orderBy: { number: 'desc' },
    });
  });
});

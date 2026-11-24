import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDueWeeks } from '../../src/services/consistency-close-service.js';
import { ruleForWeek } from '../../src/services/consistency-config-service.js';
import { pausesFor } from '../../src/services/consistency-pause-service.js';
import { countDone } from '../../src/services/consistency-progress-service.js';
import { materializeTargets } from '../../src/services/consistency-target-service.js';
import { WeekStatus } from '../../src/constants/consistency-ranking.js';

vi.mock('../../src/services/consistency-config-service.js', () => ({ getConfig: vi.fn(), ruleForWeek: vi.fn() }));
vi.mock('../../src/services/consistency-pause-service.js', () => ({ pausesFor: vi.fn() }));
vi.mock('../../src/services/consistency-progress-service.js', () => ({ countDone: vi.fn() }));
vi.mock('../../src/services/consistency-season-service.js', () => ({ ensureCurrentSeasonLocked: vi.fn() }));
vi.mock('../../src/services/consistency-target-service.js', () => ({ materializeTargets: vi.fn() }));

const TRAINER_ID = 'trainer-1';
const RULE = {
  weights: { workouts: 50, diet: 0, cardio: 50, feedback: 0, hydration: 0 },
  activePillars: ['workouts', 'cardio'],
  closeWeekday: 0,
  closeHour: 21,
  timeZone: 'America/Sao_Paulo',
};
const LINKED_AT = new Date('2026-10-01T00:00:00.000Z');
// Sunday 2026-11-15 21:15 in São Paulo, after the close of both championship weeks
const AFTER_BOTH_CLOSES = new Date('2026-11-16T00:15:00.000Z');

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

const CHAMPIONSHIP = {
  trainerId: TRAINER_ID,
  startDate: dateOnly('2026-11-02'),
  endDate: dateOnly('2026-11-15'),
  participants: [{ studentId: 'ana' }, { studentId: 'bia' }],
};

const prisma = {
  challenge: { findMany: vi.fn() },
  consistencySeason: { findMany: vi.fn(), findFirst: vi.fn() },
  consistencyWeekClose: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  consistencyWeeklyResult: { createMany: vi.fn() },
  trainerStudent: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(async (fn) => fn(prisma)),
};
const logger = { info: vi.fn(), error: vi.fn() };

// Championships listed by the job, or those holding a Monday when the query names one
function championshipsFor({ where }) {
  const monday = where.startDate?.lte;
  if (!where.trainerId) return [CHAMPIONSHIP].filter((row) => row.startDate.getTime() <= monday.getTime());
  return [CHAMPIONSHIP].filter((row) => row.startDate <= where.startDate.lte && row.endDate >= where.endDate.gte);
}

// Active links of ana, bia and carl (not in the championship), narrowed by the query
function linksFor({ where }) {
  const links = ['ana', 'bia', 'carl'].map((studentId) => ({ studentId, createdAt: LINKED_AT }));
  return where.studentId ? links.filter((link) => where.studentId.in.includes(link.studentId)) : links;
}

beforeEach(() => {
  vi.clearAllMocks();
  ruleForWeek.mockResolvedValue(RULE);
  prisma.challenge.findMany.mockImplementation(async (args) => championshipsFor(args));
  prisma.consistencySeason.findMany.mockResolvedValue([]);
  prisma.consistencySeason.findFirst.mockResolvedValue(null);
  prisma.consistencyWeekClose.findMany.mockResolvedValue([]);
  prisma.consistencyWeekClose.findUnique.mockResolvedValue(null);
  prisma.trainerStudent.findMany.mockImplementation(async (args) => linksFor(args));
  prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
  materializeTargets.mockImplementation(async (_tx, _trainerId, _week, ids) => new Map(ids.map((id) => [id, { workouts: 2, cardio: 2 }])));
  countDone.mockImplementation(async (_tx, _trainerId, ids) => new Map(ids.map((id) => [id, { workouts: id === 'ana' ? 2 : 1, cardio: 2 }])));
  pausesFor.mockImplementation(async (_tx, _trainerId, [week]) => {
    const key = `${week.year}-${String(week.month).padStart(2, '0')}-${String(week.day).padStart(2, '0')}`;
    return new Map([[key, { team: null, students: new Map() }]]);
  });
});

describe('closeDueWeeks without an active season', () => {
  it('CAMP-72 writes the weekly result of the championship participants for each closed championship week', async () => {
    await closeDueWeeks(prisma, logger, AFTER_BOTH_CLOSES);

    const written = prisma.consistencyWeeklyResult.createMany.mock.calls.map(([{ data }]) =>
      data.map((row) => [row.studentId, row.seasonId, row.weekStart.toISOString().slice(0, 10), row.status, Number(row.score)]),
    );
    expect(written).toEqual([
      [
        ['ana', null, '2026-11-02', WeekStatus.VALID, 100],
        ['bia', null, '2026-11-02', WeekStatus.VALID, 75],
      ],
      [
        ['ana', null, '2026-11-09', WeekStatus.VALID, 100],
        ['bia', null, '2026-11-09', WeekStatus.VALID, 75],
      ],
    ]);
    expect(prisma.consistencyWeekClose.create.mock.calls.map(([{ data }]) => [data.weekStart.toISOString().slice(0, 10), data.studentsCount])).toEqual([
      ['2026-11-02', 2],
      ['2026-11-09', 2],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CAMP-72 leaves alone the weeks already closed and the trainers with an active season', async () => {
    prisma.consistencyWeekClose.findMany.mockResolvedValue([{ weekStart: dateOnly('2026-11-02') }]);

    await closeDueWeeks(prisma, logger, AFTER_BOTH_CLOSES);
    expect(prisma.consistencyWeekClose.create).toHaveBeenCalledTimes(1);
    expect(prisma.consistencyWeekClose.create.mock.calls[0][0].data.weekStart).toEqual(dateOnly('2026-11-09'));

    vi.clearAllMocks();
    prisma.consistencySeason.findMany.mockImplementation(async ({ where }) => (where.trainerId ? [{ trainerId: TRAINER_ID }] : []));
    await closeDueWeeks(prisma, logger, AFTER_BOTH_CLOSES);
    expect(prisma.consistencyWeeklyResult.createMany).not.toHaveBeenCalled();
    expect(prisma.consistencyWeekClose.create).not.toHaveBeenCalled();
  });
});

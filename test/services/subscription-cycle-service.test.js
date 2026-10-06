import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  ensureUpcomingCycles,
  cancelUpcomingPayments,
  materializeCycles,
  insertCyclesForActiveSubscriptions,
} from '../../src/services/subscription-cycle-service.js';
import {
  PaymentStatus,
  SubscriptionStatus,
  SubscriptionRecurrence,
  CYCLE_GENERATION_BATCH_SIZE,
  MAX_CYCLES_PER_GENERATION_RUN,
} from '../../src/constants/subscription.js';

const { Decimal } = Prisma;

const TODAY = new Date('2026-06-10T00:00:00Z');
const TRAINER_ID = 'trainer-1';

const mockPrisma = {
  studentSubscription: { findMany: vi.fn() },
  subscriptionPayment: { createMany: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

function makeSubscription(id, overrides = {}) {
  return {
    id,
    startDate: new Date('2026-03-01T12:00:00Z'),
    recurrence: SubscriptionRecurrence.MONTHLY,
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    ...overrides,
  };
}

function latestCycle(subscriptionId, cycleIndex, cycleEndDate) {
  return { subscriptionId, cycleIndex, cycleEndDate: new Date(`${cycleEndDate}T00:00:00Z`) };
}

const VALUES_PER_ROW = 7;

/** Decode the rows bound into the last $executeRaw INSERT. */
function insertedRows() {
  const joined = mockPrisma.$executeRaw.mock.calls.at(-1)[2];
  const rows = [];
  for (let offset = 0; offset < joined.values.length; offset += VALUES_PER_ROW) {
    const [subscriptionId, cycleIndex, cycleStartDate, cycleEndDate, dueDate, amount, notes] =
      joined.values.slice(offset, offset + VALUES_PER_ROW);
    rows.push({ subscriptionId, cycleIndex, cycleStartDate, cycleEndDate, dueDate, amount, notes });
  }
  return rows;
}

beforeEach(() => {
  vi.resetAllMocks();
  // $executeRaw is a tagged template: (strings, pendingStatus, joinedValuesSql, activeStatus). The
  // joined VALUES list carries 7 bound values per row.
  mockPrisma.$executeRaw.mockImplementation(async (_strings, _pendingStatus, joined) => joined.values.length / VALUES_PER_ROW);
});

describe('ensureUpcomingCycles', () => {
  it('queries only ACTIVE subscriptions (cancelled ones are ignored), scoped to the trainer when given', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([]);

    const result = await ensureUpcomingCycles(mockPrisma, { trainerId: TRAINER_ID, today: TODAY });

    expect(result).toEqual({ subscriptionsChecked: 0, cyclesCreated: 0 });
    const args = mockPrisma.studentSubscription.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: SubscriptionStatus.ACTIVE, trainerId: TRAINER_ID });
    expect(args.take).toBe(CYCLE_GENERATION_BATCH_SIZE);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('processes every trainer (no trainerId filter) for the cron path', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('skips already-ended cycles: a stale subscription gets only the current cycle (no burst of past charges)', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription('s1')]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 0, '2026-03-31')]);

    const result = await ensureUpcomingCycles(mockPrisma, { trainerId: TRAINER_ID, today: TODAY });

    expect(result).toEqual({ subscriptionsChecked: 1, cyclesCreated: 1 });
    expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce();
    const rows = insertedRows();
    expect(rows.map((row) => row.cycleIndex)).toEqual([3]);
    expect(rows.map((row) => row.cycleStartDate)).toEqual(['2026-06-01']);
    expect(rows.map((row) => row.cycleEndDate)).toEqual(['2026-06-30']);
  });

  it('creates pending-insert rows with dueDate = cycleStartDate, the discounted net amount and the subscription id', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscription('s1', { price: new Decimal('99.90'), discountPercent: new Decimal('33.33') }),
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 2, '2026-05-31')]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    const rows = insertedRows();
    expect(rows).toEqual([
      {
        subscriptionId: 's1',
        cycleIndex: 3,
        cycleStartDate: '2026-06-01',
        cycleEndDate: '2026-06-30',
        dueDate: '2026-06-01',
        amount: '66.60',
        notes: null,
      },
    ]);
  });

  it('inserts through one conditional statement that re-checks the subscription is active and locks it', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription('s1')]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    const sqlText = mockPrisma.$executeRaw.mock.calls[0][0].join('?');
    expect(sqlText).toContain('JOIN student_subscriptions s');
    expect(sqlText).toContain('FOR SHARE OF s');
    // Deterministic lock order across concurrent runs avoids deadlocks.
    expect(sqlText.replace(/\s+/g, ' ')).toContain('ORDER BY r.subscription_id, r.cycle_index');
    expect(sqlText.indexOf('ORDER BY')).toBeLessThan(sqlText.indexOf('FOR SHARE OF s'));
    expect(sqlText).toContain('ON CONFLICT (subscription_id, cycle_index) DO NOTHING');
    expect(mockPrisma.$executeRaw.mock.calls[0]).toContain(SubscriptionStatus.ACTIVE);
    expect(mockPrisma.subscriptionPayment.createMany).not.toHaveBeenCalled();
  });

  it('starts from grid cycle 0 when the subscription has no cycle yet and creates cycle 0 + upcoming within the lead window', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscription('s1', { startDate: new Date('2026-06-10T12:00:00Z') }),
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(insertedRows().map((row) => row.cycleIndex)).toEqual([0]);
  });

  it('a subscription backdated one year (monthly) creates only the current cycle, not 12 past ones', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscription('s1', { startDate: new Date('2025-06-10T00:00:00Z') }),
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    const rows = insertedRows();
    expect(rows.map((row) => row.cycleIndex)).toEqual([12]);
    expect(rows[0].cycleStartDate).toBe('2026-06-10');
  });

  it('also creates the upcoming cycle when it starts within the 7-day lead window', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscription('s1', { startDate: new Date('2025-06-15T00:00:00Z') }),
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(insertedRows().map((row) => row.cycleIndex)).toEqual([11, 12]);
  });

  it('is idempotent: a second run (latest cycle already materialized) issues no insert', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription('s1')]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 3, '2026-06-30')]);

    const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(result).toEqual({ subscriptionsChecked: 1, cyclesCreated: 0 });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('reports only rows actually inserted when ON CONFLICT / the active check dropped some', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription('s1')]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 0, '2026-03-31')]);
    mockPrisma.$executeRaw.mockResolvedValue(0);

    const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(result.cyclesCreated).toBe(0);
  });

  describe('lead window (today + 7 days) boundary', () => {
    it('materializes a cycle starting exactly today + 7', async () => {
      mockPrisma.studentSubscription.findMany.mockResolvedValue([
        makeSubscription('s1', { startDate: new Date('2026-03-17T12:00:00Z') }),
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 2, '2026-06-16')]); // next = Jun 17

      const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

      expect(result.cyclesCreated).toBe(1);
      expect(insertedRows()[0].cycleStartDate).toBe('2026-06-17');
    });

    it('does not materialize a cycle starting at today + 8', async () => {
      mockPrisma.studentSubscription.findMany.mockResolvedValue([
        makeSubscription('s1', { startDate: new Date('2026-03-18T12:00:00Z') }),
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 2, '2026-06-17')]); // next = Jun 18

      const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

      expect(result.cyclesCreated).toBe(0);
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('never creates more than MAX_CYCLES_PER_GENERATION_RUN cycles per subscription', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscription('s1', { startDate: new Date('2000-01-01T12:00:00Z') }),
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(insertedRows().length).toBeLessThanOrEqual(MAX_CYCLES_PER_GENERATION_RUN);
    expect(insertedRows().map((row) => row.cycleIndex)).toEqual([317]);
  });

  it('uses a constant number of queries regardless of how many subscriptions need cycles', async () => {
    const subscriptions = Array.from({ length: 50 }, (_, index) => makeSubscription(`s${index}`));
    mockPrisma.studentSubscription.findMany.mockResolvedValue(subscriptions);
    mockPrisma.$queryRaw.mockResolvedValue(
      subscriptions.map((subscription) => latestCycle(subscription.id, 0, '2026-03-31')),
    );

    await ensureUpcomingCycles(mockPrisma, { trainerId: TRAINER_ID, today: TODAY });

    expect(mockPrisma.studentSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(insertedRows()).toHaveLength(50);
  });

  it('with nothing due it costs exactly two queries (subscriptions + latest cycles)', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription('s1')]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('s1', 3, '2026-06-30')]);

    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(mockPrisma.studentSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  describe('batching by cursor', () => {
    it('pages through subscriptions with where id > lastSeenId (no cursor/skip) until a short page', async () => {
      const fullBatch = Array.from({ length: CYCLE_GENERATION_BATCH_SIZE }, (_, index) =>
        makeSubscription(`a${index}`),
      );
      const lastPage = [makeSubscription('b0'), makeSubscription('b1')];
      mockPrisma.studentSubscription.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce(lastPage);
      mockPrisma.$queryRaw.mockImplementation(async () => []);

      const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

      expect(mockPrisma.studentSubscription.findMany).toHaveBeenCalledTimes(2);
      const [firstCall, secondCall] = mockPrisma.studentSubscription.findMany.mock.calls.map(
        ([args]) => args,
      );
      expect(firstCall.where.id).toBeUndefined();
      expect(firstCall.orderBy).toEqual({ id: 'asc' });
      expect(secondCall.where.id).toEqual({ gt: `a${CYCLE_GENERATION_BATCH_SIZE - 1}` });
      expect(secondCall.orderBy).toEqual({ id: 'asc' });
      expect(secondCall.cursor).toBeUndefined();
      expect(secondCall.skip).toBeUndefined();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(result.subscriptionsChecked).toBe(CYCLE_GENERATION_BATCH_SIZE + 2);
    });

    it('keeps the status and trainer filters on every page', async () => {
      const fullBatch = Array.from({ length: CYCLE_GENERATION_BATCH_SIZE }, (_, index) =>
        makeSubscription(`a${index}`),
      );
      mockPrisma.studentSubscription.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await ensureUpcomingCycles(mockPrisma, { trainerId: TRAINER_ID, today: TODAY });

      const secondWhere = mockPrisma.studentSubscription.findMany.mock.calls[1][0].where;
      expect(secondWhere).toMatchObject({ status: SubscriptionStatus.ACTIVE, trainerId: TRAINER_ID });
    });

    it('stops when the page after a full batch is empty', async () => {
      const fullBatch = Array.from({ length: CYCLE_GENERATION_BATCH_SIZE }, (_, index) =>
        makeSubscription(`a${index}`),
      );
      mockPrisma.studentSubscription.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

      expect(mockPrisma.studentSubscription.findMany).toHaveBeenCalledTimes(2);
      expect(result.subscriptionsChecked).toBe(CYCLE_GENERATION_BATCH_SIZE);
    });
  });
});

describe('insertCyclesForActiveSubscriptions', () => {
  it('returns 0 without touching the database when there are no rows', async () => {
    const inserted = await insertCyclesForActiveSubscriptions(mockPrisma, []);

    expect(inserted).toBe(0);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns the number of rows the statement inserted', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const inserted = await insertCyclesForActiveSubscriptions(mockPrisma, [
      {
        subscriptionId: 's1',
        cycleIndex: 0,
        cycleStartDate: new Date('2026-06-01T00:00:00Z'),
        cycleEndDate: new Date('2026-06-30T00:00:00Z'),
        dueDate: new Date('2026-06-01T00:00:00Z'),
        amount: new Decimal('10'),
        notes: null,
      },
    ]);

    expect(inserted).toBe(1);
  });
});

describe('cancelUpcomingPayments', () => {
  const NOW = new Date('2026-06-10T12:00:00Z');

  it('voids pending payments whose cycle has not started with a single updateMany, stamping voidedAt', async () => {
    mockPrisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 2 });
    const where = { trainerId: TRAINER_ID, studentId: 'student-1' };

    const count = await cancelUpcomingPayments(mockPrisma, where, TODAY, { now: NOW });

    expect(count).toBe(2);
    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledOnce();
    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        status: PaymentStatus.PENDING,
        cycleStartDate: { gt: TODAY },
        subscription: where,
      },
      data: { status: PaymentStatus.CANCELLED, voidedAt: NOW },
    });
  });

  it('voids ONLY pending payments starting on/after replacementCycleStart when replacing a plan (no upcoming branch)', async () => {
    mockPrisma.subscriptionPayment.updateMany.mockResolvedValue({ count: 1 });
    const replacementCycleStart = new Date('2026-06-30T00:00:00Z');

    await cancelUpcomingPayments(mockPrisma, { id: { in: ['a'] } }, TODAY, {
      now: NOW,
      replacementCycleStart,
    });

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        status: PaymentStatus.PENDING,
        cycleStartDate: { gte: replacementCycleStart },
        subscription: { id: { in: ['a'] } },
      },
      data: { status: PaymentStatus.CANCELLED, voidedAt: NOW },
    });
  });
});

describe('materializeCycles', () => {
  const LIMIT = new Date('2026-07-20T00:00:00Z');

  it('inserts the missing cycles up to the generation limit in one conditional insert', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('a', 0, '2026-03-31')]);

    const inserted = await materializeCycles(mockPrisma, [makeSubscription('a')], LIMIT, TODAY);

    expect(inserted).toBe(insertedRows().length);
    expect(insertedRows().map((row) => row.cycleStartDate)).toEqual(['2026-06-01', '2026-07-01']);
  });

  it('drops cycles starting on/before minCycleStart', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('a', 0, '2026-03-31')]);

    await materializeCycles(mockPrisma, [makeSubscription('a')], LIMIT, TODAY, TODAY);

    expect(insertedRows().map((row) => row.cycleStartDate)).toEqual(['2026-07-01']);
  });

  it('does not write when minCycleStart filters out every cycle', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('a', 0, '2026-03-31')]);

    const inserted = await materializeCycles(mockPrisma, [makeSubscription('a')], LIMIT, TODAY, LIMIT);

    expect(inserted).toBe(0);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });
});

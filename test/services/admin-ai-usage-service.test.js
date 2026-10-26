import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAiUsageByMonth } from '../../src/services/admin-ai-usage-service.js';

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  aiTokenUsage: { groupBy: vi.fn() },
  trainer: { findMany: vi.fn() },
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MONTH = '2026-10';
const TRAINER_A = 'trainer-a';
const TRAINER_B = 'trainer-b';
const TRAINER_C = 'trainer-c';

// Builds a groupBy row of summed token counters for one trainer.
function makeGroup(trainerId, sums = {}, turns = 1) {
  return {
    trainerId,
    _sum: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...sums,
    },
    _count: { _all: turns },
  };
}

// Builds a trainer row with user and optional subscription tier.
function makeTrainer(id, { firstName, lastName, email, tier } = {}) {
  return {
    id,
    user: { firstName, lastName, email },
    platformSubscription: tier ? { tier } : null,
  };
}

// ─── getAiUsageByMonth ────────────────────────────────────────────────────────

describe('getAiUsageByMonth', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([]);
    mockPrisma.trainer.findMany.mockResolvedValue([]);
  });

  it('returns zeroed totals and an empty list when nothing was used in the month', async () => {
    const result = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(result).toEqual({
      month: MONTH,
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        turns: 0,
      },
      trainers: [],
    });
  });

  it('filters usage rows by the requested billing month', async () => {
    await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(mockPrisma.aiTokenUsage.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ billingMonth: MONTH }),
      })
    );
  });

  it('defaults to the current UTC month when month is omitted', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-31T23:30:00Z') });

    const result = await getAiUsageByMonth(mockPrisma, {});

    expect(result.month).toBe('2026-03');
    expect(mockPrisma.aiTokenUsage.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ billingMonth: '2026-03' }),
      })
    );
  });

  it('computes per-trainer totalTokens as input + output + cacheRead + cacheWrite', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      makeGroup(TRAINER_A, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
      }, 3),
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainer(TRAINER_A, { firstName: 'Ana', lastName: 'Lima', email: 'ana@example.com', tier: 'PRO' }),
    ]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers).toEqual([
      {
        trainerId: TRAINER_A,
        firstName: 'Ana',
        lastName: 'Lima',
        email: 'ana@example.com',
        tier: 'PRO',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        totalTokens: 180,
        turns: 3,
      },
    ]);
  });

  it('aggregates month totals across trainers', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      makeGroup(TRAINER_A, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 }, 3),
      makeGroup(TRAINER_B, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1 }, 2),
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainer(TRAINER_A, { tier: 'PRO' }),
      makeTrainer(TRAINER_B, { tier: 'DIAMOND' }),
    ]);

    const { totals } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(totals).toEqual({
      inputTokens: 110,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheWriteTokens: 11,
      totalTokens: 196,
      turns: 5,
    });
  });

  it('sorts trainers by totalTokens descending', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      makeGroup(TRAINER_A, { inputTokens: 10 }),
      makeGroup(TRAINER_B, { inputTokens: 1000 }),
      makeGroup(TRAINER_C, { inputTokens: 100 }),
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainer(TRAINER_A, { tier: 'PRO' }),
      makeTrainer(TRAINER_B, { tier: 'PRO' }),
      makeTrainer(TRAINER_C, { tier: 'PRO' }),
    ]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers.map((t) => t.trainerId)).toEqual([TRAINER_B, TRAINER_C, TRAINER_A]);
  });

  it('sorts by the full totalTokens, including cache tokens', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      makeGroup(TRAINER_A, { inputTokens: 500 }),
      makeGroup(TRAINER_B, { inputTokens: 100, cacheReadTokens: 900 }),
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainer(TRAINER_A, { tier: 'PRO' }),
      makeTrainer(TRAINER_B, { tier: 'PRO' }),
    ]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers.map((t) => t.trainerId)).toEqual([TRAINER_B, TRAINER_A]);
  });

  it('reports FREE for trainers without a subscription row', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([makeGroup(TRAINER_A, { inputTokens: 1 })]);
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainer(TRAINER_A)]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers[0].tier).toBe('FREE');
  });

  it('lists only trainers that have usage in the month', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([makeGroup(TRAINER_A, { inputTokens: 1 })]);
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainer(TRAINER_A, { tier: 'PRO' })]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers.map((t) => t.trainerId)).toEqual([TRAINER_A]);
  });

  it('looks up only the trainers that appear in the usage groups', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      makeGroup(TRAINER_A, { inputTokens: 1 }),
      makeGroup(TRAINER_B, { inputTokens: 2 }),
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainer(TRAINER_A, { tier: 'PRO' }),
      makeTrainer(TRAINER_B, { tier: 'PRO' }),
    ]);

    await getAiUsageByMonth(mockPrisma, { month: MONTH });

    const { where } = mockPrisma.trainer.findMany.mock.calls[0][0];
    expect(where.id.in).toEqual(expect.arrayContaining([TRAINER_A, TRAINER_B]));
  });

  it('treats null token sums as zero', async () => {
    mockPrisma.aiTokenUsage.groupBy.mockResolvedValue([
      {
        trainerId: TRAINER_A,
        _sum: { inputTokens: 40, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
        _count: { _all: 1 },
      },
    ]);
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainer(TRAINER_A, { tier: 'PRO' })]);

    const { trainers } = await getAiUsageByMonth(mockPrisma, { month: MONTH });

    expect(trainers[0].totalTokens).toBe(40);
  });
});

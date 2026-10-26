import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLM_PROVIDERS } from '../../src/constants/ai.js';
import {
  createUsageAccumulator,
  recordTokenUsage,
} from '../../src/services/ai-token-usage-service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-uuid-1';
const STUDENT_ID = 'student-uuid-1';
const CONVERSATION_ID = 'conversation-uuid-1';
const MODEL = 'claude-test-model';

const FIRST_CALL_USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
};
const SECOND_CALL_USAGE = {
  inputTokens: 200,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 5,
};

const mockPrisma = {
  aiTokenUsage: { create: vi.fn() },
};

// ─── createUsageAccumulator ───────────────────────────────────────────────────

describe('createUsageAccumulator', () => {
  it('reports no usage before anything is added', () => {
    const accumulator = createUsageAccumulator();

    expect(accumulator.hasUsage()).toBe(false);
  });

  it('sums every token counter across multiple calls', () => {
    const accumulator = createUsageAccumulator();

    accumulator.add(FIRST_CALL_USAGE);
    accumulator.add(SECOND_CALL_USAGE);

    expect(accumulator.totals()).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 50,
      cacheWriteTokens: 15,
    });
  });

  it('ignores null usage without affecting totals', () => {
    const accumulator = createUsageAccumulator();

    accumulator.add(FIRST_CALL_USAGE);
    accumulator.add(null);

    expect(accumulator.totals()).toMatchObject(FIRST_CALL_USAGE);
  });

  it('ignores undefined usage', () => {
    const accumulator = createUsageAccumulator();

    accumulator.add(undefined);

    expect(accumulator.hasUsage()).toBe(false);
  });

  it('keeps hasUsage false when only null usage was added', () => {
    const accumulator = createUsageAccumulator();

    accumulator.add(null);
    accumulator.add(null);

    expect(accumulator.hasUsage()).toBe(false);
  });

  it('reports hasUsage true after one real usage object', () => {
    const accumulator = createUsageAccumulator();

    accumulator.add(FIRST_CALL_USAGE);

    expect(accumulator.hasUsage()).toBe(true);
  });

  it('keeps accumulators independent from each other', () => {
    const first = createUsageAccumulator();
    const second = createUsageAccumulator();

    first.add(FIRST_CALL_USAGE);

    expect(second.hasUsage()).toBe(false);
  });
});

// ─── recordTokenUsage ─────────────────────────────────────────────────────────

describe('recordTokenUsage', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    mockPrisma.aiTokenUsage.create.mockResolvedValue({});
  });

  function baseParams(overrides = {}) {
    return {
      trainerId: TRAINER_ID,
      studentId: STUDENT_ID,
      conversationId: CONVERSATION_ID,
      provider: LLM_PROVIDERS.ANTHROPIC,
      model: MODEL,
      usage: { ...FIRST_CALL_USAGE },
      llmCalls: 2,
      ...overrides,
    };
  }

  it('creates one AiTokenUsage row carrying the summed usage and call count', async () => {
    await recordTokenUsage(mockPrisma, baseParams());

    expect(mockPrisma.aiTokenUsage.create).toHaveBeenCalledOnce();
    expect(mockPrisma.aiTokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trainerId: TRAINER_ID,
        studentId: STUDENT_ID,
        conversationId: CONVERSATION_ID,
        provider: LLM_PROVIDERS.ANTHROPIC,
        model: MODEL,
        inputTokens: FIRST_CALL_USAGE.inputTokens,
        outputTokens: FIRST_CALL_USAGE.outputTokens,
        cacheReadTokens: FIRST_CALL_USAGE.cacheReadTokens,
        cacheWriteTokens: FIRST_CALL_USAGE.cacheWriteTokens,
        llmCalls: 2,
      }),
    });
  });

  it('writes billingMonth as YYYY-MM', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });

    await recordTokenUsage(mockPrisma, baseParams());

    const { data } = mockPrisma.aiTokenUsage.create.mock.calls[0][0];
    expect(data.billingMonth).toBe('2026-10');
  });

  it('computes billingMonth in UTC at the end of a month', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-31T23:30:00Z') });

    await recordTokenUsage(mockPrisma, baseParams());

    const { data } = mockPrisma.aiTokenUsage.create.mock.calls[0][0];
    expect(data.billingMonth).toBe('2026-03');
  });

  it('computes billingMonth in UTC right after a month rollover', async () => {
    vi.useFakeTimers({ now: new Date('2026-04-01T00:30:00Z') });

    await recordTokenUsage(mockPrisma, baseParams());

    const { data } = mockPrisma.aiTokenUsage.create.mock.calls[0][0];
    expect(data.billingMonth).toBe('2026-04');
  });

  it('accepts a turn without student or conversation', async () => {
    await recordTokenUsage(mockPrisma, baseParams({ studentId: null, conversationId: null }));

    const { data } = mockPrisma.aiTokenUsage.create.mock.calls[0][0];
    expect(data.studentId ?? null).toBeNull();
    expect(data.conversationId ?? null).toBeNull();
  });

  it('never throws when prisma fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.aiTokenUsage.create.mockRejectedValue(new Error('db down'));

    await expect(recordTokenUsage(mockPrisma, baseParams())).resolves.toBeUndefined();
  });

  it('logs the failure when prisma fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.aiTokenUsage.create.mockRejectedValue(new Error('db down'));

    await recordTokenUsage(mockPrisma, baseParams());

    expect(errorSpy).toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import {
  overviewPeriodWindows,
  overviewWeekStarts,
  estimateAiCostUsd,
} from '../../src/helpers/admin-overview.js';
import {
  OVERVIEW_PERIODS,
  OVERVIEW_DEFAULT_PERIOD,
  OVERVIEW_WEEKLY_BUCKETS,
} from '../../src/constants/admin-manager.js';
import { AI_MODEL_PRICES_USD_PER_MTOK } from '../../src/constants/ai-pricing.js';
import { AI_MODELS } from '../../src/constants/ai.js';

const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-11-24T15:00:00.000Z');
const PERIOD_DAYS = [
  [OVERVIEW_PERIODS.DAYS_7, 7],
  [OVERVIEW_PERIODS.DAYS_30, 30],
  [OVERVIEW_PERIODS.DAYS_90, 90],
];
const WEEK_COUNT = 8;
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';
const UNKNOWN_MODEL = 'model-unknown';
const PRICE_TABLE = Object.freeze({
  [MODEL_A]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  [MODEL_B]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
});
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Builds a per-model token counter with zeroed defaults.
function counter(model, tokens = {}) {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...tokens };
}

// Returns the instant `days` days before the given instant.
function daysBefore(instant, days) {
  return new Date(instant.getTime() - days * MS_PER_DAY);
}

// Returns the number of whole days between two YYYY-MM-DD strings.
function civilDayDiff(earlier, later) {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / MS_PER_DAY;
}

describe('overview constants', () => {
  it('should expose the 7d, 30d and 90d periods in that order', () => {
    expect(Object.values(OVERVIEW_PERIODS)).toEqual(['7d', '30d', '90d']);
  });

  it('should default the period to 30d', () => {
    expect(OVERVIEW_DEFAULT_PERIOD).toBe('30d');
  });

  it('should use 8 weekly buckets', () => {
    expect(OVERVIEW_WEEKLY_BUCKETS).toBe(WEEK_COUNT);
  });
});

describe('overviewPeriodWindows', () => {
  it.each(PERIOD_DAYS)('should end the current %s window at now and start it P days before', (period, days) => {
    const windows = overviewPeriodWindows(NOW, period);

    expect(windows.to.getTime()).toBe(NOW.getTime());
    expect(windows.from.getTime()).toBe(daysBefore(NOW, days).getTime());
  });

  it.each(PERIOD_DAYS)('should place the previous %s window immediately before the current one', (period, days) => {
    const windows = overviewPeriodWindows(NOW, period);

    expect(windows.previousTo.getTime()).toBe(windows.from.getTime());
    expect(windows.previousFrom.getTime()).toBe(daysBefore(NOW, 2 * days).getTime());
  });

  it('should return Date instances', () => {
    const windows = overviewPeriodWindows(NOW, OVERVIEW_PERIODS.DAYS_30);

    expect([windows.from, windows.to, windows.previousFrom, windows.previousTo].every((value) => value instanceof Date)).toBe(true);
  });
});

describe('overviewWeekStarts', () => {
  it('should return 8 week starts', () => {
    expect(overviewWeekStarts(NOW)).toHaveLength(WEEK_COUNT);
  });

  it('should end with the Monday of the current Sao Paulo week', () => {
    expect(overviewWeekStarts(NOW).at(-1)).toBe('2026-11-23');
  });

  it('should start 7 weeks before the current week', () => {
    expect(overviewWeekStarts(NOW)[0]).toBe('2026-10-05');
  });

  it('should list consecutive Mondays oldest to newest, 7 days apart', () => {
    const weekStarts = overviewWeekStarts(NOW);

    const gaps = weekStarts.slice(1).map((weekStart, index) => civilDayDiff(weekStarts[index], weekStart));
    expect(gaps).toEqual(Array(WEEK_COUNT - 1).fill(7));
  });

  it('should format every week start as YYYY-MM-DD', () => {
    expect(overviewWeekStarts(NOW).every((weekStart) => /^\d{4}-\d{2}-\d{2}$/.test(weekStart))).toBe(true);
  });

  it('should keep Monday 01:00 UTC (Sunday 22:00 in Sao Paulo) in the previous week', () => {
    expect(overviewWeekStarts(new Date('2026-11-23T01:00:00.000Z')).at(-1)).toBe('2026-11-16');
  });

  it('should start a new week at Monday 00:00 in Sao Paulo (03:00 UTC)', () => {
    expect(overviewWeekStarts(new Date('2026-11-23T03:00:00.000Z')).at(-1)).toBe('2026-11-23');
  });

  it('should use the real Sao Paulo offset during historical DST (UTC-2)', () => {
    expect(overviewWeekStarts(new Date('2018-11-05T02:30:00.000Z')).at(-1)).toBe('2018-11-05');
  });

  it('should cross the year boundary', () => {
    expect(overviewWeekStarts(new Date('2027-01-01T12:00:00.000Z')).at(-1)).toBe('2026-12-28');
  });
});

describe('estimateAiCostUsd', () => {
  it('should return zero and complete for no counters', () => {
    expect(estimateAiCostUsd([], PRICE_TABLE)).toEqual({ estimatedCostUsd: 0, costComplete: true });
  });

  it('should price each token kind with its per-million rate', () => {
    const counters = [counter(MODEL_A, {
      inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000,
    })];

    expect(estimateAiCostUsd(counters, PRICE_TABLE)).toEqual({ estimatedCostUsd: 6.6, costComplete: true });
  });

  it('should sum the cost across counters and models', () => {
    const counters = [
      counter(MODEL_A, { inputTokens: 1_000_000 }),
      counter(MODEL_A, { outputTokens: 100_000 }),
      counter(MODEL_B, { inputTokens: 500_000 }),
    ];

    expect(estimateAiCostUsd(counters, PRICE_TABLE).estimatedCostUsd).toBe(5);
  });

  it('should round the total to cents', () => {
    const counters = [counter(MODEL_A, { inputTokens: 9_000 })];

    expect(estimateAiCostUsd(counters, PRICE_TABLE).estimatedCostUsd).toBe(0.03);
  });

  it('should exclude a model without a price from the total', () => {
    const counters = [
      counter(MODEL_B, { inputTokens: 2_000_000 }),
      counter(UNKNOWN_MODEL, { inputTokens: 9_000_000 }),
    ];

    expect(estimateAiCostUsd(counters, PRICE_TABLE).estimatedCostUsd).toBe(2);
  });

  it('should flag the cost as incomplete when a model has no price', () => {
    const counters = [counter(MODEL_B, { inputTokens: 1 }), counter(UNKNOWN_MODEL, { inputTokens: 1 })];

    expect(estimateAiCostUsd(counters, PRICE_TABLE).costComplete).toBe(false);
  });

  it('should flag the cost as incomplete when the only model is unknown', () => {
    expect(estimateAiCostUsd([counter(UNKNOWN_MODEL, { inputTokens: 10 })], PRICE_TABLE)).toEqual({
      estimatedCostUsd: 0,
      costComplete: false,
    });
  });
});

describe('AI_MODEL_PRICES_USD_PER_MTOK', () => {
  it('should price the configured Anthropic model', () => {
    expect(AI_MODEL_PRICES_USD_PER_MTOK).toHaveProperty([AI_MODELS.ANTHROPIC]);
  });

  it.each(PRICE_FIELDS)('should give the Anthropic model a positive %s price', (field) => {
    const price = AI_MODEL_PRICES_USD_PER_MTOK[AI_MODELS.ANTHROPIC]?.[field];

    expect(typeof price === 'number' && price > 0).toBe(true);
  });
});

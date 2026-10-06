import { describe, expect, it, vi } from 'vitest';
import {
  addMonthsClamped,
  currentYearMonthInBusinessTz,
  diffInDays,
  firstDayOfNextMonthUtc,
  formatDateOnly,
  monthWindowInBusinessTz,
  parseDateOnlyAsUtc,
  todayInBusinessTz,
  zonedWallClockToInstant,
} from '../../src/helpers/date-helpers.js';

describe('date-helpers', () => {
  it('formats date as YYYY-MM-DD using UTC fields', () => {
    const value = formatDateOnly(new Date('2025-02-01T00:00:00.000Z'));
    expect(value).toBe('2025-02-01');
  });

  it('parses date-only strings in stable UTC noon', () => {
    const parsed = parseDateOnlyAsUtc('2025-02-01');

    expect(parsed.toISOString()).toBe('2025-02-01T12:00:00.000Z');
  });

  it('returns null when parse input is empty', () => {
    expect(parseDateOnlyAsUtc(null)).toBeNull();
    expect(parseDateOnlyAsUtc(undefined)).toBeNull();
  });
});

describe('business timezone helpers (America/Sao_Paulo)', () => {
  it('todayInBusinessTz(null) falls back to now instead of the 1970 epoch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T02:30:00Z')); // 23:30 BRT on Jun 10
    try {
      expect(todayInBusinessTz(null).toISOString()).toBe('2026-06-10T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('todayInBusinessTz keeps 23:30 BRT on the same civil day although UTC rolled over', () => {
    const result = todayInBusinessTz(new Date('2026-06-11T02:30:00Z')); // 23:30 BRT on Jun 10

    expect(result.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('todayInBusinessTz maps 00:30 UTC to the previous Sao Paulo day', () => {
    const result = todayInBusinessTz(new Date('2026-06-10T00:30:00Z')); // 21:30 BRT on Jun 9

    expect(result.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('todayInBusinessTz rolls to the next day exactly at 03:00 UTC (00:00 BRT)', () => {
    expect(todayInBusinessTz(new Date('2026-06-10T02:59:59Z')).toISOString()).toBe(
      '2026-06-09T00:00:00.000Z',
    );
    expect(todayInBusinessTz(new Date('2026-06-10T03:00:00Z')).toISOString()).toBe(
      '2026-06-10T00:00:00.000Z',
    );
  });

  it('monthWindowInBusinessTz returns [start, end) at local midnight (UTC-3)', () => {
    const { start, end } = monthWindowInBusinessTz('2026-06');

    expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-01T03:00:00.000Z');
  });

  it('monthWindowInBusinessTz wraps December into January of the next year', () => {
    const { start, end } = monthWindowInBusinessTz('2026-12');

    expect(start.toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('monthWindowInBusinessTz includes 23:30 BRT on the last day and excludes 00:00 BRT of the next month', () => {
    const { start, end } = monthWindowInBusinessTz('2026-05');
    const lastMinuteOfMay = new Date('2026-05-31T23:30:00-03:00');
    const firstMinuteOfJune = new Date('2026-06-01T00:00:00-03:00');

    expect(lastMinuteOfMay >= start && lastMinuteOfMay < end).toBe(true);
    expect(firstMinuteOfJune < end).toBe(false);
  });

  it('currentYearMonthInBusinessTz uses the Sao Paulo month, not the UTC one', () => {
    expect(currentYearMonthInBusinessTz(new Date('2026-07-01T01:00:00Z'))).toBe('2026-06');
    expect(currentYearMonthInBusinessTz(new Date('2026-07-01T03:00:00Z'))).toBe('2026-07');
  });

  it('firstDayOfNextMonthUtc returns midnight UTC of the next month, wrapping the year', () => {
    expect(firstDayOfNextMonthUtc('2026-06').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(firstDayOfNextMonthUtc('2026-12').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('zonedWallClockToInstant converts a Sao Paulo wall clock to the right instant', () => {
    const instant = zonedWallClockToInstant({ year: 2026, month: 5, day: 31 }, 'America/Sao_Paulo', 12);

    expect(instant.toISOString()).toBe('2026-05-31T15:00:00.000Z');
  });
});

describe('addMonthsClamped', () => {
  const utc = (iso) => new Date(`${iso}T00:00:00Z`);

  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-08-31', 1, '2026-09-30'],
    ['2026-11-30', 3, '2027-02-28'],
    ['2026-12-15', 2, '2027-02-15'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2026-05-10', 0, '2026-05-10'],
  ])('%s + %i months => %s', (anchor, months, expected) => {
    expect(formatDateOnly(addMonthsClamped(utc(anchor), months))).toBe(expected);
  });
});

describe('diffInDays', () => {
  it('returns whole days between two midnight-UTC dates', () => {
    expect(diffInDays(new Date('2026-06-10T00:00:00Z'), new Date('2026-06-01T00:00:00Z'))).toBe(9);
  });

  it('is negative when the first date is earlier', () => {
    expect(diffInDays(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-10T00:00:00Z'))).toBe(-9);
  });

  it('absorbs the 12:00 vs 00:00 offset of date-only values', () => {
    expect(diffInDays(new Date('2026-06-10T00:00:00Z'), new Date('2026-06-09T12:00:00Z'))).toBe(1);
  });
});

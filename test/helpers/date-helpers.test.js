import { describe, expect, it } from 'vitest';
import { formatDateOnly, parseDateOnlyAsUtc } from '../../src/helpers/date-helpers.js';

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

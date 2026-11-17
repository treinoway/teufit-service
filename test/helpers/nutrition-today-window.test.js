import { describe, it, expect } from 'vitest';
import { assertDayWritable, writableDayWindow } from '../../src/helpers/nutrition-today.js';
import { formatDateOnly } from '../../src/helpers/date-helpers.js';
import { NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

const HTTP_UNPROCESSABLE = 422;
const NOW = new Date('2026-11-02T15:00:00.000Z');
const JUST_AFTER_MIDNIGHT_UTC = new Date('2026-11-03T01:00:00.000Z');
const FIRST_PUBLISHED_AT = new Date('2026-10-30T12:00:00.000Z');
const FIRST_PUBLISHED_LATE_EVENING_SP = new Date('2026-10-31T01:30:00.000Z');

// Test helper: formatted bounds of the writable window.
function windowBounds(options) {
  const { from, to } = writableDayWindow(options);
  return { from: formatDateOnly(from), to: formatDateOnly(to) };
}

describe('writableDayWindow', () => {
  it('should span from the first published day to tomorrow', () => {
    expect(windowBounds({ firstPublishedAt: FIRST_PUBLISHED_AT, now: NOW })).toEqual({ from: '2026-10-30', to: '2026-11-03' });
  });

  it('should start today when the plan has no first publication date', () => {
    expect(windowBounds({ firstPublishedAt: null, now: NOW })).toEqual({ from: '2026-11-02', to: '2026-11-03' });
  });

  it('should resolve the first published day in the business timezone, not UTC', () => {
    expect(windowBounds({ firstPublishedAt: FIRST_PUBLISHED_LATE_EVENING_SP, now: NOW }).from).toBe('2026-10-30');
  });

  it('should use the business timezone for today near midnight UTC', () => {
    expect(windowBounds({ firstPublishedAt: null, now: JUST_AFTER_MIDNIGHT_UTC }).from).toBe('2026-11-02');
  });

  it('should accept an ISO string for firstPublishedAt', () => {
    expect(windowBounds({ firstPublishedAt: FIRST_PUBLISHED_AT.toISOString(), now: NOW }).from).toBe('2026-10-30');
  });
});

describe('assertDayWritable', () => {
  const options = { firstPublishedAt: FIRST_PUBLISHED_AT, now: NOW };

  it.each(['2026-10-30', '2026-11-02', '2026-11-03'])('should accept %s inside the window', (date) => {
    expect(() => assertDayWritable(date, options)).not.toThrow();
  });

  it.each(['2026-10-29', '2026-11-04'])('should throw 422 day out of range for %s', (date) => {
    expect(() => assertDayWritable(date, options)).toThrow(
      expect.objectContaining({
        httpStatus: HTTP_UNPROCESSABLE,
        error: NutritionErrorCode.DAY_OUT_OF_RANGE,
        messageCode: NutritionMessageCode.DAY_OUT_OF_RANGE,
      }),
    );
  });
});

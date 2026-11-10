import { describe, it, expect } from 'vitest';
import {
  weekStartFor,
  weekBounds,
  doneWindow,
  expectedFromProtocols,
} from '../../src/helpers/consistency-week.js';

const SP = 'America/Sao_Paulo';
const SUNDAY_21 = { closeWeekday: 0, closeHour: 21, timeZone: SP };
const SATURDAY_18 = { closeWeekday: 6, closeHour: 18, timeZone: SP };

// Civil date shorthand
const day = (year, month, d) => ({ year, month, day: d });

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Monday 2026-11-09 .. Sunday 2026-11-15
const FULL_WEEK = [
  day(2026, 11, 9),
  day(2026, 11, 10),
  day(2026, 11, 11),
  day(2026, 11, 12),
  day(2026, 11, 13),
  day(2026, 11, 14),
  day(2026, 11, 15),
];

// Builds a protocol covering the whole test week unless overridden
function protocol(trainings, overrides = {}) {
  return {
    startDate: dateOnly('2026-11-01'),
    expirationDate: dateOnly('2026-12-31'),
    trainings,
    ...overrides,
  };
}

describe('weekStartFor', () => {
  it('returns the same civil day for a Monday', () => {
    expect(weekStartFor(new Date('2026-11-09T15:00:00Z'), SP)).toEqual(day(2026, 11, 9));
  });

  it('returns the previous Monday for a Sunday', () => {
    expect(weekStartFor(new Date('2026-11-15T15:00:00Z'), SP)).toEqual(day(2026, 11, 9));
  });

  it('uses the local civil date when UTC is already on the next day', () => {
    expect(weekStartFor(new Date('2026-11-16T02:30:00Z'), SP)).toEqual(day(2026, 11, 9));
  });

  it('uses the local civil date when UTC is still on the previous day', () => {
    expect(weekStartFor(new Date('2026-11-15T15:30:00Z'), 'Asia/Tokyo')).toEqual(day(2026, 11, 16));
  });

  it('crosses month and year boundaries', () => {
    expect(weekStartFor(new Date('2027-01-02T12:00:00Z'), SP)).toEqual(day(2026, 12, 28));
  });
});

describe('weekBounds', () => {
  it('starts on Monday 00:00 local time', () => {
    const { startInstant } = weekBounds(day(2026, 11, 9), SUNDAY_21);
    expect(startInstant.toISOString()).toBe('2026-11-09T03:00:00.000Z');
  });

  it('closes on Sunday 21:00 local time and schedules all seven days', () => {
    const { closeInstant, scheduleDays } = weekBounds(day(2026, 11, 9), SUNDAY_21);
    expect(closeInstant.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(scheduleDays).toEqual(FULL_WEEK);
  });

  it('with close on Saturday, Sunday generates no target', () => {
    const { closeInstant, scheduleDays } = weekBounds(day(2026, 11, 9), SATURDAY_18);
    expect(closeInstant.toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(scheduleDays).toEqual(FULL_WEEK.slice(0, 6));
  });

  it('with close on Monday, schedules only Monday', () => {
    const { scheduleDays } = weekBounds(day(2026, 11, 9), { closeWeekday: 1, closeHour: 8, timeZone: SP });
    expect(scheduleDays).toEqual([day(2026, 11, 9)]);
  });

  it('resolves the close in the trainer timezone even when UTC is on another civil date', () => {
    const rule = { closeWeekday: 0, closeHour: 23, timeZone: SP };
    const { closeInstant } = weekBounds(day(2026, 11, 9), rule);
    expect(closeInstant.toISOString()).toBe('2026-11-16T02:00:00.000Z');
    expect(closeInstant.getUTCDay()).toBe(1);
  });

  it('handles a timezone ahead of UTC', () => {
    const rule = { closeWeekday: 0, closeHour: 21, timeZone: 'Asia/Tokyo' };
    const { startInstant, closeInstant } = weekBounds(day(2026, 11, 9), rule);
    expect(startInstant.toISOString()).toBe('2026-11-08T15:00:00.000Z');
    expect(closeInstant.toISOString()).toBe('2026-11-15T12:00:00.000Z');
  });
});

describe('doneWindow', () => {
  it('runs from the previous week close to this week close with no gap (AD-006)', () => {
    const weekStart = day(2026, 11, 9);
    const { from, to } = doneWindow(weekStart, SUNDAY_21, SUNDAY_21);
    const previousClose = weekBounds(day(2026, 11, 2), SUNDAY_21).closeInstant;
    const thisClose = weekBounds(weekStart, SUNDAY_21).closeInstant;
    expect(from.getTime()).toBe(previousClose.getTime());
    expect(to.getTime()).toBe(thisClose.getTime());
    expect(from.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('chains consecutive weeks: this week from equals previous week to', () => {
    const first = doneWindow(day(2026, 11, 2), SUNDAY_21, SUNDAY_21);
    const second = doneWindow(day(2026, 11, 9), SUNDAY_21, SUNDAY_21);
    expect(second.from.getTime()).toBe(first.to.getTime());
  });

  it('uses the previous rule for the start and the current rule for the end when the close changed', () => {
    const { from, to } = doneWindow(day(2026, 11, 9), SATURDAY_18, SUNDAY_21);
    expect(from.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-14T21:00:00.000Z');
  });

  it('falls back to the current rule when there is no previous rule', () => {
    const { from } = doneWindow(day(2026, 11, 9), SUNDAY_21, null);
    expect(from.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('expectedFromProtocols', () => {
  it('RANK-02 counts weekday occurrences plus 1 per undated training', () => {
    const protocols = [
      protocol([
        { weekDay: 'monday', category: 'strength' },
        { weekDay: 'wednesday', category: 'functional' },
        { weekDay: null, category: 'mobility' },
        { weekDay: null, category: 'flexibility' },
      ]),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 4, cardio: 0 });
  });

  it('RANK-03 counts cardio trainings in the cardio pillar', () => {
    const protocols = [
      protocol([
        { weekDay: 'tuesday', category: 'cardio' },
        { weekDay: null, category: 'cardio' },
        { weekDay: 'friday', category: 'strength' },
      ]),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 1, cardio: 2 });
  });

  it('RANK-47 stops counting after the expiration date', () => {
    const protocols = [
      protocol(
        [
          { weekDay: 'wednesday', category: 'strength' },
          { weekDay: 'thursday', category: 'strength' },
          { weekDay: 'friday', category: 'cardio' },
        ],
        { expirationDate: dateOnly('2026-11-12') },
      ),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 2, cardio: 0 });
  });

  it('RANK-48 sums two active protocols', () => {
    const protocols = [
      protocol([{ weekDay: 'monday', category: 'strength' }, { weekDay: null, category: 'cardio' }]),
      protocol([{ weekDay: 'monday', category: 'functional' }, { weekDay: 'saturday', category: 'cardio' }]),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 2, cardio: 2 });
  });

  it('RANK-53 ignores rest trainings', () => {
    const protocols = [
      protocol([
        { weekDay: 'sunday', category: 'rest' },
        { weekDay: null, category: 'rest' },
        { weekDay: 'monday', category: 'strength' },
      ]),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 1, cardio: 0 });
  });

  it('does not count weekdays outside the schedule days (close on Saturday drops Sunday)', () => {
    const protocols = [
      protocol([
        { weekDay: 'sunday', category: 'strength' },
        { weekDay: 'saturday', category: 'strength' },
      ]),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK.slice(0, 6))).toEqual({ workouts: 1, cardio: 0 });
  });

  it('still counts undated trainings when the schedule has a single day', () => {
    const protocols = [protocol([{ weekDay: null, category: 'strength' }])];
    expect(expectedFromProtocols(protocols, [day(2026, 11, 9)])).toEqual({ workouts: 1, cardio: 0 });
  });

  it('does not count days before the protocol start date', () => {
    const protocols = [
      protocol(
        [
          { weekDay: 'monday', category: 'strength' },
          { weekDay: 'thursday', category: 'strength' },
        ],
        { startDate: dateOnly('2026-11-11') },
      ),
    ];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 1, cardio: 0 });
  });

  it('treats a null expiration date as open ended', () => {
    const protocols = [protocol([{ weekDay: 'sunday', category: 'strength' }], { expirationDate: null })];
    expect(expectedFromProtocols(protocols, FULL_WEEK)).toEqual({ workouts: 1, cardio: 0 });
  });

  it('returns zeros without protocols', () => {
    expect(expectedFromProtocols([], FULL_WEEK)).toEqual({ workouts: 0, cardio: 0 });
  });
});

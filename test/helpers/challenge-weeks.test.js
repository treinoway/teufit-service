import { describe, it, expect } from 'vitest';
import {
  weeksSpan,
  validateWeeksInput,
  weeklyStatus,
  currentWeekOf,
} from '../../src/helpers/challenge-weeks.js';
import { ChallengeErrorCode, ChallengeMessageCode, ChallengeStatus } from '../../src/constants/challenge.js';

const SP = 'America/Sao_Paulo';

// Date-only column value (midnight UTC), as Prisma returns @db.Date
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Wednesday 2026-11-18 12:00 in São Paulo (UTC-3); the current week starts Monday 2026-11-16
const WEDNESDAY = new Date('2026-11-18T15:00:00.000Z');

// Captures the AppError thrown by fn (or null)
function thrownBy(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

// Asserts the call rejects the weeks input with 400 challenge.weeks.invalid
function expectInvalidWeeks(input) {
  const error = thrownBy(() => validateWeeksInput(input, { timeZone: SP, now: WEDNESDAY }));
  expect(error).not.toBeNull();
  expect(error.httpStatus).toBe(400);
  expect(error.error).toBe(ChallengeErrorCode.CHALLENGE_INVALID_WEEKS);
  expect(error.messageCode).toBe(ChallengeMessageCode.CHALLENGE_INVALID_WEEKS);
}

// Asserts the call rejects the podium minimum with 400 challenge.minPodium.invalid
function expectInvalidMinPodium(input) {
  const error = thrownBy(() => validateWeeksInput(input, { timeZone: SP, now: WEDNESDAY }));
  expect(error).not.toBeNull();
  expect(error.httpStatus).toBe(400);
  expect(error.error).toBe(ChallengeErrorCode.CHALLENGE_INVALID_MIN_PODIUM);
  expect(error.messageCode).toBe(ChallengeMessageCode.CHALLENGE_INVALID_MIN_PODIUM);
}

// Weekly championship row as Prisma returns it
function weekly(overrides = {}) {
  return {
    format: 'weeks',
    startDate: dateOnly('2026-11-23'),
    endDate: dateOnly('2026-12-20'),
    weeks: 4,
    cancelledAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe('weeksSpan', () => {
  it('CAMP-04 starts on the chosen Monday and ends on the Sunday of the last week', () => {
    const span = weeksSpan({ startWeek: '2026-11-23', weeks: 8 });
    expect(span.startDate).toEqual(dateOnly('2026-11-23'));
    expect(span.endDate).toEqual(dateOnly('2027-01-17'));
  });

  it('CAMP-04 spans Monday to Sunday of the same week for a 1 week championship', () => {
    const span = weeksSpan({ startWeek: '2026-11-16', weeks: 1 });
    expect(span.startDate).toEqual(dateOnly('2026-11-16'));
    expect(span.endDate).toEqual(dateOnly('2026-11-22'));
  });
});

describe('validateWeeksInput', () => {
  it('CAMP-06 rejects a start that is not a Monday, is in the past or weeks out of 1 to 12', () => {
    expectInvalidWeeks({ startWeek: '2026-11-17', weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-11-22', weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-11-09', weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-13-01', weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: 'next monday', weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: undefined, weeks: 4, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-11-23', weeks: 0, minPodiumWeeks: 1 });
    expectInvalidWeeks({ startWeek: '2026-11-23', weeks: 13, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-11-23', weeks: 2.5, minPodiumWeeks: 2 });
    expectInvalidWeeks({ startWeek: '2026-11-23', weeks: '4', minPodiumWeeks: 2 });

    expect(() => validateWeeksInput(
      { startWeek: '2026-11-16', weeks: 1, minPodiumWeeks: 1 },
      { timeZone: SP, now: WEDNESDAY },
    )).not.toThrow();
    expect(() => validateWeeksInput(
      { startWeek: '2026-11-23', weeks: 12, minPodiumWeeks: 4 },
      { timeZone: SP, now: WEDNESDAY },
    )).not.toThrow();
  });

  it('CAMP-06 uses the current Monday of the trainer time zone, not of UTC', () => {
    const sundayNightInSaoPaulo = new Date('2026-11-23T02:30:00.000Z');
    expect(() => validateWeeksInput(
      { startWeek: '2026-11-16', weeks: 1, minPodiumWeeks: 1 },
      { timeZone: SP, now: sundayNightInSaoPaulo },
    )).not.toThrow();
    expect(() => validateWeeksInput(
      { startWeek: '2026-11-16', weeks: 1, minPodiumWeeks: 1 },
      { timeZone: 'UTC', now: sundayNightInSaoPaulo },
    )).toThrow();
  });

  it('CAMP-07 accepts the podium minimum only from 1 to min(4, weeks)', () => {
    expectInvalidMinPodium({ startWeek: '2026-11-23', weeks: 8, minPodiumWeeks: 0 });
    expectInvalidMinPodium({ startWeek: '2026-11-23', weeks: 8, minPodiumWeeks: 5 });
    expectInvalidMinPodium({ startWeek: '2026-11-23', weeks: 2, minPodiumWeeks: 3 });
    expectInvalidMinPodium({ startWeek: '2026-11-23', weeks: 1, minPodiumWeeks: 2 });
    expectInvalidMinPodium({ startWeek: '2026-11-23', weeks: 8, minPodiumWeeks: 1.5 });

    for (const minPodiumWeeks of [1, 2, 3, 4]) {
      expect(() => validateWeeksInput(
        { startWeek: '2026-11-23', weeks: 8, minPodiumWeeks },
        { timeZone: SP, now: WEDNESDAY },
      )).not.toThrow();
    }
    expect(() => validateWeeksInput(
      { startWeek: '2026-11-23', weeks: 2, minPodiumWeeks: 2 },
      { timeZone: SP, now: WEDNESDAY },
    )).not.toThrow();
    expect(() => validateWeeksInput(
      { startWeek: '2026-11-23', weeks: 1, minPodiumWeeks: 1 },
      { timeZone: SP, now: WEDNESDAY },
    )).not.toThrow();
  });
});

describe('weeklyStatus', () => {
  it('CAMP-36 turns active at Monday 00:00 in the trainer time zone', () => {
    const challenge = weekly();
    const sundayLastMinuteSp = new Date('2026-11-23T02:59:00.000Z');
    const mondayMidnightSp = new Date('2026-11-23T03:00:00.000Z');

    expect(weeklyStatus(challenge, { now: sundayLastMinuteSp, timeZone: SP })).toBe(ChallengeStatus.SCHEDULED);
    expect(weeklyStatus(challenge, { now: mondayMidnightSp, timeZone: SP })).toBe(ChallengeStatus.ACTIVE);
    expect(weeklyStatus(challenge, { now: new Date('2026-11-23T00:30:00.000Z'), timeZone: 'UTC' }))
      .toBe(ChallengeStatus.ACTIVE);
  });

  it('CAMP-36 stays active after the last Sunday until the championship is closed', () => {
    const afterEnd = new Date('2026-12-21T15:00:00.000Z');
    expect(weeklyStatus(weekly(), { now: afterEnd, timeZone: SP })).toBe(ChallengeStatus.ACTIVE);
  });

  it('CAMP-36 reports completed once closed and cancelled above everything else', () => {
    const during = new Date('2026-11-25T15:00:00.000Z');
    expect(weeklyStatus(weekly({ closedAt: new Date('2026-12-21T00:10:00.000Z') }), { now: during, timeZone: SP }))
      .toBe(ChallengeStatus.COMPLETED);
    expect(weeklyStatus(
      weekly({ closedAt: new Date('2026-12-21T00:10:00.000Z'), cancelledAt: new Date('2026-11-24T10:00:00.000Z') }),
      { now: during, timeZone: SP },
    )).toBe(ChallengeStatus.CANCELLED);
    expect(weeklyStatus(weekly({ cancelledAt: new Date('2026-11-20T10:00:00.000Z') }), { now: WEDNESDAY, timeZone: SP }))
      .toBe(ChallengeStatus.CANCELLED);
  });
});

describe('currentWeekOf', () => {
  it('CAMP-49 numbers the championship week of a Monday from 1 to the number of weeks', () => {
    const challenge = weekly();
    expect(currentWeekOf(challenge, dateOnly('2026-11-23'))).toBe(1);
    expect(currentWeekOf(challenge, dateOnly('2026-11-30'))).toBe(2);
    expect(currentWeekOf(challenge, dateOnly('2026-12-14'))).toBe(4);
  });

  it('CAMP-49 returns 0 before the start and the last week after the end', () => {
    const challenge = weekly();
    expect(currentWeekOf(challenge, dateOnly('2026-11-16'))).toBe(0);
    expect(currentWeekOf(challenge, dateOnly('2026-12-21'))).toBe(4);
  });
});

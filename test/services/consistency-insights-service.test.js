import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  faixaFor,
  riskFor,
  seasonPillars,
  signalsFor,
  weakestPillar,
} from '../../src/services/consistency-insights-service.js';
import { Faixa, Pillar, SignalType, WeekStatus } from '../../src/constants/consistency-ranking.js';

const { Decimal } = Prisma;
const CLOSE_INSTANT = new Date('2026-11-16T00:00:00Z');
const MINUTE_MS = 60000;
const RULES = { minWorkoutMinutes: 10, batchCount: 5, batchMinutes: 30 };
const RISK_RULES = { riskLimit: 70, riskWeeks: 2 };

// Stored weekly result, most recent first when listed
function result(status, score, pillars = {}) {
  return { status, score: score === null ? null : new Decimal(score), pillars };
}

// Pillar counts as stored with a closed week
function counts(expected, done) {
  return { expected, done };
}

// Completed session finishing the given minutes before the close
function sessionBeforeClose(id, minutesBefore, durationSeconds = 3600) {
  return { id, finishedAt: new Date(CLOSE_INSTANT.getTime() - minutesBefore * MINUTE_MS), durationSeconds };
}

describe('faixaFor', () => {
  it('PAN-10 maps averages to bands', () => {
    expect(faixaFor(100, true)).toBe(Faixa.FULL);
    expect(faixaFor(new Decimal('99.99'), true)).toBe(Faixa.CONSTANT);
    expect(faixaFor(85, true)).toBe(Faixa.CONSTANT);
    expect(faixaFor(new Decimal('84.99'), true)).toBe(Faixa.STEADY);
    expect(faixaFor(70, true)).toBe(Faixa.STEADY);
    expect(faixaFor(new Decimal('69.99'), true)).toBe(Faixa.RESTARTING);
    expect(faixaFor(0, true)).toBe(Faixa.RESTARTING);
  });

  it('PAN-10 reports Entering when the student lacks the minimum for the podium', () => {
    expect(faixaFor(100, false)).toBe(Faixa.ENTERING);
    expect(faixaFor(40, false)).toBe(Faixa.ENTERING);
  });
});

describe('riskFor', () => {
  it('PAN-20 returns the weeks that caused the risk', () => {
    const closed = [result(WeekStatus.VALID, 58), result(WeekStatus.VALID, 64), result(WeekStatus.VALID, 100)];

    expect(riskFor(closed, RISK_RULES)).toEqual({ atRisk: true, scores: [64, 58] });
  });

  it('PAN-20 skips neutral and paused weeks', () => {
    const closed = [
      result(WeekStatus.PAUSED, null),
      result(WeekStatus.VALID, 58),
      result(WeekStatus.NEUTRAL, null),
      result(WeekStatus.VALID, 64),
    ];

    expect(riskFor(closed, RISK_RULES)).toEqual({ atRisk: true, scores: [64, 58] });
  });

  it('PAN-20 is not at risk when one of the last weeks reaches the limit', () => {
    const closed = [result(WeekStatus.VALID, 70), result(WeekStatus.VALID, 40)];

    expect(riskFor(closed, RISK_RULES)).toEqual({ atRisk: false, scores: [] });
  });

  it('PAN-20 is not at risk with fewer valid weeks than the configured number', () => {
    const closed = [result(WeekStatus.VALID, 50), result(WeekStatus.PAUSED, null)];

    expect(riskFor(closed, RISK_RULES)).toEqual({ atRisk: false, scores: [] });
  });

  it('PAN-20 looks at as many recent valid weeks as the rule asks', () => {
    const closed = [result(WeekStatus.VALID, 60), result(WeekStatus.VALID, 65), result(WeekStatus.VALID, 90)];

    expect(riskFor(closed, { riskLimit: 70, riskWeeks: 2 }).atRisk).toBe(true);
    expect(riskFor(closed, { riskLimit: 70, riskWeeks: 3 })).toEqual({ atRisk: false, scores: [] });
  });

  it('PAN-20 uses the configured limit', () => {
    const closed = [result(WeekStatus.VALID, 80), result(WeekStatus.VALID, 75)];

    expect(riskFor(closed, { riskLimit: 85, riskWeeks: 2 })).toEqual({ atRisk: true, scores: [75, 80] });
  });
});

describe('seasonPillars', () => {
  it('PAN-22 sums closed weeks per pillar', () => {
    const closed = [
      result(WeekStatus.VALID, 80, { workouts: counts(3, 2), cardio: counts(2, 1) }),
      result(WeekStatus.VALID, 90, { workouts: counts(3, 3), cardio: counts(2, 1) }),
    ];

    expect(seasonPillars(closed)).toEqual([
      { pillar: Pillar.WORKOUTS, done: 5, expected: 6, adherence: 83.3333 },
      { pillar: Pillar.CARDIO, done: 2, expected: 4, adherence: 50 },
    ]);
  });

  it('PAN-22 leaves out pillars without a target and paused or neutral weeks', () => {
    const closed = [
      result(WeekStatus.VALID, 100, { workouts: counts(3, 3), cardio: counts(0, 0) }),
      result(WeekStatus.PAUSED, null, { workouts: counts(3, 0), cardio: counts(2, 0) }),
      result(WeekStatus.NEUTRAL, null, { workouts: counts(3, 0) }),
    ];

    expect(seasonPillars(closed)).toEqual([{ pillar: Pillar.WORKOUTS, done: 3, expected: 3, adherence: 100 }]);
  });

  it('PAN-22 counts a week over target as the target, never above it', () => {
    const closed = [
      result(WeekStatus.VALID, 100, { workouts: counts(2, 4) }),
      result(WeekStatus.VALID, 50, { workouts: counts(2, 1) }),
    ];

    expect(seasonPillars(closed)).toEqual([{ pillar: Pillar.WORKOUTS, done: 3, expected: 4, adherence: 75 }]);
  });

  it('PAN-22 returns an empty list without closed weeks', () => {
    expect(seasonPillars([])).toEqual([]);
  });
});

describe('weakestPillar', () => {
  it('PAN-23 picks the pillar with the lowest adherence', () => {
    const pillars = [
      { pillar: Pillar.WORKOUTS, done: 5, expected: 6, adherence: 83.3333 },
      { pillar: Pillar.CARDIO, done: 1, expected: 4, adherence: 25 },
    ];

    expect(weakestPillar(pillars)).toBe(Pillar.CARDIO);
  });

  it('PAN-23 breaks ties by Workouts, Cardio, Feedback, Hydration, Diet', () => {
    const tied = [
      { pillar: Pillar.DIET, done: 1, expected: 2, adherence: 50 },
      { pillar: Pillar.HYDRATION, done: 1, expected: 2, adherence: 50 },
      { pillar: Pillar.CARDIO, done: 1, expected: 2, adherence: 50 },
    ];

    expect(weakestPillar(tied)).toBe(Pillar.CARDIO);
    expect(weakestPillar(tied.slice(0, 2))).toBe(Pillar.HYDRATION);
  });

  it('PAN-23 returns null without pillars', () => {
    expect(weakestPillar([])).toBeNull();
  });
});

describe('signalsFor', () => {
  it('PAN-48 flags quick completions', () => {
    const sessions = [
      { id: 'quick', finishedAt: new Date('2026-11-10T12:00:00Z'), durationSeconds: 240 },
      { id: 'edge', finishedAt: new Date('2026-11-10T13:00:00Z'), durationSeconds: 599 },
      { id: 'enough', finishedAt: new Date('2026-11-10T14:00:00Z'), durationSeconds: 600 },
      { id: 'unknown', finishedAt: new Date('2026-11-10T15:00:00Z'), durationSeconds: null },
    ];

    expect(signalsFor(sessions, CLOSE_INSTANT, RULES)).toEqual([
      { type: SignalType.QUICK_COMPLETION, sessionId: 'quick', finishedAt: sessions[0].finishedAt, durationSeconds: 240 },
      { type: SignalType.QUICK_COMPLETION, sessionId: 'edge', finishedAt: sessions[1].finishedAt, durationSeconds: 599 },
    ]);
  });

  it('PAN-48 uses the configured minimum', () => {
    const sessions = [{ id: 'a', finishedAt: new Date('2026-11-10T12:00:00Z'), durationSeconds: 1000 }];

    expect(signalsFor(sessions, CLOSE_INSTANT, { ...RULES, minWorkoutMinutes: 20 })).toHaveLength(1);
    expect(signalsFor(sessions, CLOSE_INSTANT, { ...RULES, minWorkoutMinutes: 0 })).toEqual([]);
  });

  it('PAN-49 flags batch logging before the close', () => {
    const sessions = [1, 5, 10, 20, 29].map((minutes) => sessionBeforeClose(`s${minutes}`, minutes));

    expect(signalsFor(sessions, CLOSE_INSTANT, RULES)).toEqual([
      { type: SignalType.BATCH_LOGGING, count: 5, closeInstant: CLOSE_INSTANT },
    ]);
  });

  it('PAN-49 does not flag fewer sessions than the configured count', () => {
    const sessions = [1, 5, 10, 20].map((minutes) => sessionBeforeClose(`s${minutes}`, minutes));

    expect(signalsFor(sessions, CLOSE_INSTANT, RULES)).toEqual([]);
  });

  it('PAN-49 ignores sessions finished outside the minutes before the close', () => {
    const sessions = [1, 5, 10, 20, 31].map((minutes) => sessionBeforeClose(`s${minutes}`, minutes));

    expect(signalsFor(sessions, CLOSE_INSTANT, RULES)).toEqual([]);
  });

  it('PAN-49 uses the configured count and minutes', () => {
    const sessions = [1, 50, 90].map((minutes) => sessionBeforeClose(`s${minutes}`, minutes));

    expect(signalsFor(sessions, CLOSE_INSTANT, { ...RULES, batchCount: 3, batchMinutes: 120 })).toEqual([
      { type: SignalType.BATCH_LOGGING, count: 3, closeInstant: CLOSE_INSTANT },
    ]);
  });

  it('PAN-52 leaves the score unchanged', () => {
    const session = Object.freeze({ id: 'quick', finishedAt: new Date('2026-11-10T12:00:00Z'), durationSeconds: 60 });
    const sessions = Object.freeze([session]);

    const signals = signalsFor(sessions, CLOSE_INSTANT, RULES);

    expect(signals).toHaveLength(1);
    expect(Object.keys(signals[0]).sort()).toEqual(['durationSeconds', 'finishedAt', 'sessionId', 'type']);
    expect(sessions).toEqual([session]);
  });
});

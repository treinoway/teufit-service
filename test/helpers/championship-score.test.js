import { describe, it, expect } from 'vitest';
import { rescoreClosedWeek } from '../../src/helpers/championship-score.js';
import { Pillar, WeekStatus } from '../../src/constants/consistency-ranking.js';

const GENERAL_RULE = {
  weights: { workouts: 60, cardio: 40, diet: 0, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
};
const WORKOUTS_ONLY = {
  weights: { workouts: 100, cardio: 0, diet: 0, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS],
};
const HALF_AND_HALF = {
  weights: { workouts: 50, cardio: 50, diet: 0, feedback: 0, hydration: 0 },
  activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
};

// Stored weekly result with per-pillar counts and the rule recorded at close
function storedWeek({ status, workouts, cardio, weights = GENERAL_RULE }) {
  return {
    status,
    score: null,
    pillars: { workouts: { expected: workouts[0], done: workouts[1] }, cardio: { expected: cardio[0], done: cardio[1] } },
    weights,
  };
}

// Plain number of a Decimal score, null stays null
const num = (value) => (value === null ? null : value.toNumber());

describe('rescoreClosedWeek', () => {
  it('CPD-09 scores a closed week with the championship weights from the stored pillar counts', () => {
    const row = storedWeek({ status: WeekStatus.VALID, workouts: [3, 3], cardio: [2, 0] });

    const workoutsOnly = rescoreClosedWeek(row, WORKOUTS_ONLY);
    expect(workoutsOnly.status).toBe(WeekStatus.VALID);
    expect(num(workoutsOnly.score)).toBe(100);

    const halfAndHalf = rescoreClosedWeek(row, HALF_AND_HALF);
    expect(halfAndHalf.status).toBe(WeekStatus.VALID);
    expect(num(halfAndHalf.score)).toBe(50);
  });

  it('CPD-10 keeps a week neutral by late entry and a paused week paused', () => {
    const lateEntry = storedWeek({ status: WeekStatus.NEUTRAL, workouts: [3, 3], cardio: [2, 2] });
    expect(rescoreClosedWeek(lateEntry, WORKOUTS_ONLY)).toEqual({ status: WeekStatus.NEUTRAL, score: null });

    const paused = storedWeek({ status: WeekStatus.PAUSED, workouts: [3, 3], cardio: [2, 2] });
    expect(rescoreClosedWeek(paused, WORKOUTS_ONLY)).toEqual({ status: WeekStatus.PAUSED, score: null });
  });

  it('CPD-11 makes a week neutral when no active championship pillar had a target', () => {
    const cardioOnlyWeek = storedWeek({ status: WeekStatus.VALID, workouts: [0, 0], cardio: [2, 2] });

    expect(rescoreClosedWeek(cardioOnlyWeek, WORKOUTS_ONLY)).toEqual({ status: WeekStatus.NEUTRAL, score: null });
  });

  it('CPD-09 rescores a stored result without a recorded rule with the championship weights', () => {
    const validWithoutRule = storedWeek({ status: WeekStatus.VALID, workouts: [4, 2], cardio: [2, 2], weights: null });
    const valid = rescoreClosedWeek(validWithoutRule, WORKOUTS_ONLY);
    expect(valid.status).toBe(WeekStatus.VALID);
    expect(num(valid.score)).toBe(50);

    const neutralWithoutRule = storedWeek({ status: WeekStatus.NEUTRAL, workouts: [3, 3], cardio: [0, 0], weights: null });
    const rescored = rescoreClosedWeek(neutralWithoutRule, WORKOUTS_ONLY);
    expect(rescored.status).toBe(WeekStatus.VALID);
    expect(num(rescored.score)).toBe(100);
  });
});

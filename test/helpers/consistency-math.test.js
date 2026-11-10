import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  scoreWeek,
  liveAverage,
  isEligible,
  currentStreak,
  rankStandings,
} from '../../src/helpers/consistency-math.js';
import { Pillar, WeekStatus, DEFAULT_CONFIG } from '../../src/constants/consistency-ranking.js';

const { Decimal } = Prisma;

const WEIGHTS = { workouts: 30, cardio: 15, diet: 30, feedback: 15, hydration: 10 };

// Plain number of a Decimal result, null stays null
const num = (value) => (value === null ? null : value.toNumber());

describe('scoreWeek', () => {
  it('RANK-05 caps each pillar at 100%', () => {
    const score = scoreWeek({
      expected: { workouts: 5, cardio: 2 },
      done: { workouts: 6, cardio: 2 },
      weights: WEIGHTS,
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(score)).toBe(100);

    const overDone = scoreWeek({
      expected: { workouts: 5, cardio: 2 },
      done: { workouts: 50, cardio: 0 },
      weights: WEIGHTS,
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(overDone)).toBe(66.6667);
  });

  it('RANK-06 weights only active pillars with a target', () => {
    const spec = scoreWeek({
      expected: { workouts: 5, cardio: 2 },
      done: { workouts: 5, cardio: 1 },
      weights: WEIGHTS,
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(spec)).toBe(83.3333);

    const inactiveIgnored = scoreWeek({
      expected: { workouts: 5, cardio: 2, diet: 7 },
      done: { workouts: 5, cardio: 1, diet: 0 },
      weights: WEIGHTS,
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(inactiveIgnored)).toBe(83.3333);

    const noTargetIgnored = scoreWeek({
      expected: { workouts: 5, cardio: 0 },
      done: { workouts: 2, cardio: 0 },
      weights: WEIGHTS,
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(noTargetIgnored)).toBe(40);

    const zeroWeightIgnored = scoreWeek({
      expected: { workouts: 5, cardio: 2 },
      done: { workouts: 5, cardio: 0 },
      weights: { ...WEIGHTS, cardio: 0 },
      activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
    });
    expect(num(zeroWeightIgnored)).toBe(100);
  });

  it('RANK-06 with the default config only workouts and cardio count', () => {
    const score = scoreWeek({
      expected: { workouts: 5, cardio: 3, diet: 7, feedback: 0, hydration: 0 },
      done: { workouts: 4, cardio: 2, diet: 7 },
      weights: DEFAULT_CONFIG.weights,
      activePillars: DEFAULT_CONFIG.activePillars,
    });
    expect(num(score)).toBe(75.5556);
  });

  it('RANK-07 returns null when no pillar has a target', () => {
    expect(
      scoreWeek({
        expected: { workouts: 0, cardio: 0 },
        done: { workouts: 3, cardio: 1 },
        weights: WEIGHTS,
        activePillars: [Pillar.WORKOUTS, Pillar.CARDIO],
      }),
    ).toBeNull();

    expect(
      scoreWeek({
        expected: { workouts: 4 },
        done: { workouts: 4 },
        weights: WEIGHTS,
        activePillars: [Pillar.CARDIO],
      }),
    ).toBeNull();

    expect(
      scoreWeek({
        expected: { workouts: 4 },
        done: { workouts: 4 },
        weights: { ...WEIGHTS, workouts: 0 },
        activePillars: [Pillar.WORKOUTS],
      }),
    ).toBeNull();
  });
});

describe('liveAverage', () => {
  it('RANK-18 averages valid weeks only', () => {
    expect(num(liveAverage([new Decimal(100), new Decimal('85.2')], null))).toBe(92.6);
    expect(num(liveAverage([new Decimal(80)], null))).toBe(80);
    expect(liveAverage([], null)).toBeNull();
  });

  it('RANK-19 never lowers the live average', () => {
    const closed = [new Decimal(100), new Decimal('85.2')];
    expect(num(liveAverage(closed, new Decimal('38.3')))).toBe(92.6);

    expect(num(liveAverage([new Decimal(80)], new Decimal(100)))).toBe(90);
    expect(num(liveAverage([], new Decimal('38.3')))).toBe(38.3);
    expect(num(liveAverage([new Decimal(70)], new Decimal(70)))).toBe(70);
  });
});

describe('isEligible', () => {
  it('RANK-20 applies min(configured, elapsed) valid weeks', () => {
    expect(isEligible({ validWeeks: 1, elapsedWeeks: 1, minPodiumWeeks: 2 })).toBe(true);
    expect(isEligible({ validWeeks: 0, elapsedWeeks: 1, minPodiumWeeks: 2 })).toBe(false);
    expect(isEligible({ validWeeks: 1, elapsedWeeks: 3, minPodiumWeeks: 2 })).toBe(false);
    expect(isEligible({ validWeeks: 2, elapsedWeeks: 3, minPodiumWeeks: 2 })).toBe(true);
    expect(isEligible({ validWeeks: 3, elapsedWeeks: 4, minPodiumWeeks: 3 })).toBe(true);
    expect(isEligible({ validWeeks: 2, elapsedWeeks: 4, minPodiumWeeks: 3 })).toBe(false);
  });
});

describe('currentStreak', () => {
  const valid = (score) => ({ status: WeekStatus.VALID, score: new Decimal(score) });
  const neutral = { status: WeekStatus.NEUTRAL, score: null };
  const paused = { status: WeekStatus.PAUSED, score: null };

  it('RANK-22 skips neutral and paused weeks', () => {
    expect(currentStreak([valid(100), neutral, paused, valid(100), valid('85.2'), valid(100)])).toBe(2);
    expect(currentStreak([paused, valid(100), valid(100)])).toBe(2);
    expect(currentStreak([valid('99.9999'), valid(100)])).toBe(0);
    expect(currentStreak([neutral, paused])).toBe(0);
    expect(currentStreak([])).toBe(0);
    expect(currentStreak([valid(100), valid(100), valid(100)])).toBe(3);
  });
});

describe('rankStandings', () => {
  const row = (name, average, weeksAt100, streak) => ({
    name,
    average: new Decimal(average),
    weeksAt100,
    streak,
  });
  const summary = (rows) => rows.map((r) => [r.name, r.position]);

  it('RANK-09 compares averages at 4 decimal places', () => {
    const ranked = rankStandings([row('Bia', '97.66670001', 0, 0), row('Aline', '97.6667', 0, 0)]);
    expect(summary(ranked)).toEqual([
      ['Aline', 1],
      ['Bia', 1],
    ]);

    const distinct = rankStandings([row('Bia', '97.6666', 5, 5), row('Aline', '97.6667', 0, 0)]);
    expect(summary(distinct)).toEqual([
      ['Aline', 1],
      ['Bia', 2],
    ]);
  });

  it('RANK-21 orders by average, weeks at 100 and streak', () => {
    const byAverage = rankStandings([row('A', 90, 9, 9), row('B', 95, 0, 0)]);
    expect(byAverage.map((r) => r.name)).toEqual(['B', 'A']);

    const byWeeksAt100 = rankStandings([row('A', 90, 1, 9), row('B', 90, 2, 0)]);
    expect(byWeeksAt100.map((r) => r.name)).toEqual(['B', 'A']);

    const byStreak = rankStandings([row('A', 90, 2, 1), row('B', 90, 2, 4)]);
    expect(byStreak.map((r) => r.name)).toEqual(['B', 'A']);
    expect(byStreak.map((r) => r.position)).toEqual([1, 2]);
  });

  it('RANK-23 shares positions and skips the next ones', () => {
    const ranked = rankStandings([
      row('Paula', 98, 0, 1),
      row('Lucas', 100, 2, 5),
      row('Ana', 100, 2, 9),
      row('Bruno', 100, 2, 5),
    ]);
    expect(summary(ranked)).toEqual([
      ['Ana', 1],
      ['Bruno', 2],
      ['Lucas', 2],
      ['Paula', 4],
    ]);
  });

  it('RANK-23 lists tied rows alphabetically and keeps extra row fields', () => {
    const ranked = rankStandings([
      { ...row('Zeca', 90, 1, 1), id: 'z' },
      { ...row('Ágata', 90, 1, 1), id: 'a' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'z']);
    expect(ranked.map((r) => r.position)).toEqual([1, 1]);
    expect(rankStandings([])).toEqual([]);
  });
});

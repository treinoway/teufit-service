import { describe, it, expect } from 'vitest';
import {
  resolveReps,
  estimateExerciseDuration,
  estimateWorkoutDuration,
} from '../../src/helpers/workout-duration.js';
import { WorkoutDurationConstants } from '../../src/constants/training.js';

const { SECONDS_PER_REP, TRANSITION_SECONDS, WARMUP_OVERHEAD_SECONDS, DEFAULT_REST_SECONDS, DEFAULT_REPS_FALLBACK } = WorkoutDurationConstants;

function makeExercise(overrides = {}) {
  return {
    sets: 3,
    repetitions: { min: 8, max: 12 },
    duration: null,
    prescriptionMode: 'reps',
    restInterval: 60,
    substituteForExerciseId: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('resolveReps', () => {
  it('returns the number as-is when repetitions is a positive number', () => {
    expect(resolveReps(10)).toBe(10);
  });

  it('returns fallback when repetitions is null', () => {
    expect(resolveReps(null)).toBe(DEFAULT_REPS_FALLBACK);
  });

  it('returns fallback when repetitions is undefined', () => {
    expect(resolveReps(undefined)).toBe(DEFAULT_REPS_FALLBACK);
  });

  it('returns fallback when repetitions is a non-positive number', () => {
    expect(resolveReps(0)).toBe(DEFAULT_REPS_FALLBACK);
    expect(resolveReps(-5)).toBe(DEFAULT_REPS_FALLBACK);
  });

  it('returns ceil of midpoint for {min, max} object', () => {
    expect(resolveReps({ min: 8, max: 12 })).toBe(10);
  });

  it('returns ceil of midpoint when midpoint is not an integer', () => {
    expect(resolveReps({ min: 8, max: 9 })).toBe(Math.ceil((8 + 9) / 2));
  });

  it('returns fallback when {min, max} contains non-positive values', () => {
    expect(resolveReps({ min: 0, max: 10 })).toBe(DEFAULT_REPS_FALLBACK);
  });

  it('returns fallback when {min, max} contains NaN', () => {
    expect(resolveReps({ min: NaN, max: 10 })).toBe(DEFAULT_REPS_FALLBACK);
  });

  it('returns fallback for malformed object without min/max', () => {
    expect(resolveReps({ value: 10 })).toBe(DEFAULT_REPS_FALLBACK);
  });
});

describe('estimateExerciseDuration', () => {
  it('returns 0 for a substitute exercise', () => {
    const exercise = makeExercise({ substituteForExerciseId: 'some-principal-id' });
    expect(estimateExerciseDuration(exercise)).toBe(0);
  });

  it('returns 0 for a soft-deleted exercise', () => {
    const exercise = makeExercise({ deletedAt: new Date() });
    expect(estimateExerciseDuration(exercise)).toBe(0);
  });

  it('returns 0 when sets is 0', () => {
    const exercise = makeExercise({ sets: 0 });
    expect(estimateExerciseDuration(exercise)).toBe(0);
  });

  it('returns 0 when sets is negative', () => {
    const exercise = makeExercise({ sets: -1 });
    expect(estimateExerciseDuration(exercise)).toBe(0);
  });

  it('computes correctly for reps mode, single set (no rest)', () => {
    const exercise = makeExercise({ sets: 1, repetitions: { min: 10, max: 10 }, prescriptionMode: 'reps', restInterval: 60 });
    const work = 1 * 10 * SECONDS_PER_REP;
    const rest = 0;
    expect(estimateExerciseDuration(exercise)).toBe(work + rest + TRANSITION_SECONDS);
  });

  it('computes rest as (sets - 1) * restInterval for multiple sets', () => {
    const exercise = makeExercise({ sets: 3, repetitions: { min: 10, max: 10 }, prescriptionMode: 'reps', restInterval: 90 });
    const work = 3 * 10 * SECONDS_PER_REP;
    const rest = 2 * 90;
    expect(estimateExerciseDuration(exercise)).toBe(work + rest + TRANSITION_SECONDS);
  });

  it('uses DEFAULT_REST_SECONDS when restInterval is null', () => {
    const exercise = makeExercise({ sets: 3, repetitions: { min: 10, max: 10 }, prescriptionMode: 'reps', restInterval: null });
    const work = 3 * 10 * SECONDS_PER_REP;
    const rest = 2 * DEFAULT_REST_SECONDS;
    expect(estimateExerciseDuration(exercise)).toBe(work + rest + TRANSITION_SECONDS);
  });

  it('computes correctly for duration mode', () => {
    const exercise = makeExercise({ sets: 3, prescriptionMode: 'duration', duration: 30, repetitions: null, restInterval: 60 });
    const work = 3 * 30;
    const rest = 2 * 60;
    expect(estimateExerciseDuration(exercise)).toBe(work + rest + TRANSITION_SECONDS);
  });

  it('falls back to reps mode when prescriptionMode is duration but duration is 0', () => {
    const exercise = makeExercise({ sets: 3, prescriptionMode: 'duration', duration: 0, repetitions: { min: 10, max: 10 }, restInterval: 60 });
    const work = 3 * 10 * SECONDS_PER_REP;
    const rest = 2 * 60;
    expect(estimateExerciseDuration(exercise)).toBe(work + rest + TRANSITION_SECONDS);
  });

  it('uses DEFAULT_REPS_FALLBACK when repetitions is null in reps mode', () => {
    const exercise = makeExercise({ sets: 1, repetitions: null, prescriptionMode: 'reps', restInterval: 60 });
    const work = 1 * DEFAULT_REPS_FALLBACK * SECONDS_PER_REP;
    expect(estimateExerciseDuration(exercise)).toBe(work + TRANSITION_SECONDS);
  });

  it('defaults sets to 1 when sets is null', () => {
    const exercise = makeExercise({ sets: null, repetitions: { min: 10, max: 10 }, prescriptionMode: 'reps', restInterval: 60 });
    const work = 1 * 10 * SECONDS_PER_REP;
    expect(estimateExerciseDuration(exercise)).toBe(work + TRANSITION_SECONDS);
  });
});

describe('estimateWorkoutDuration', () => {
  it('returns 0 for a training with no exercises', () => {
    expect(estimateWorkoutDuration({ exercises: [] })).toBe(0);
  });

  it('returns 0 for a training where all exercises are substitutes', () => {
    const exercises = [
      makeExercise({ substituteForExerciseId: 'p1' }),
      makeExercise({ substituteForExerciseId: 'p1' }),
    ];
    expect(estimateWorkoutDuration({ exercises })).toBe(0);
  });

  it('returns 0 for a training where all exercises are soft-deleted', () => {
    const exercises = [makeExercise({ deletedAt: new Date() })];
    expect(estimateWorkoutDuration({ exercises })).toBe(0);
  });

  it('adds WARMUP_OVERHEAD_SECONDS when at least one exercise contributes', () => {
    const exercises = [makeExercise({ sets: 1, repetitions: { min: 10, max: 10 }, restInterval: 60 })];
    const exerciseDuration = estimateExerciseDuration(exercises[0]);
    expect(estimateWorkoutDuration({ exercises })).toBe(exerciseDuration + WARMUP_OVERHEAD_SECONDS);
  });

  it('single exercise, 1 set, reps=10: total = 10*3 + 0 + 40 + 300 = 370', () => {
    const exercises = [makeExercise({ sets: 1, repetitions: { min: 10, max: 10 }, restInterval: 60 })];
    expect(estimateWorkoutDuration({ exercises })).toBe(370);
  });

  it('excludes substitute exercises from the total', () => {
    const principal = makeExercise({ sets: 1, repetitions: { min: 10, max: 10 }, restInterval: 60 });
    const substitute = makeExercise({ substituteForExerciseId: 'principal-id', sets: 3, repetitions: { min: 10, max: 10 } });
    const withSubstitute = estimateWorkoutDuration({ exercises: [principal, substitute] });
    const withoutSubstitute = estimateWorkoutDuration({ exercises: [principal] });
    expect(withSubstitute).toBe(withoutSubstitute);
  });

  it('excludes soft-deleted exercises from the total', () => {
    const active = makeExercise({ sets: 1, repetitions: { min: 10, max: 10 }, restInterval: 60 });
    const deleted = makeExercise({ deletedAt: new Date(), sets: 5 });
    const withDeleted = estimateWorkoutDuration({ exercises: [active, deleted] });
    const withoutDeleted = estimateWorkoutDuration({ exercises: [active] });
    expect(withDeleted).toBe(withoutDeleted);
  });

  it('typical workout: 8 exercises × 4 sets × 10 reps × 90s rest should be between 3000 and 3900 seconds', () => {
    const exercises = Array.from({ length: 8 }, () =>
      makeExercise({ sets: 4, repetitions: { min: 10, max: 10 }, restInterval: 90 }),
    );
    const total = estimateWorkoutDuration({ exercises });
    expect(total).toBeGreaterThanOrEqual(3000);
    expect(total).toBeLessThanOrEqual(3900);
  });

  it('exercises property defaults to empty array when undefined', () => {
    expect(estimateWorkoutDuration({})).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { computeBestSet, resolveEffectiveExerciseId } from '../../src/helpers/best-set.js';

const EXERCISE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBSTITUTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Builds a completed set log with optional overrides.
function makeSet(overrides = {}) {
  return {
    setNumber: 1,
    repetitions: 10,
    load: 50,
    duration: null,
    rpe: null,
    restSeconds: null,
    completed: true,
    ...overrides,
  };
}

describe('computeBestSet', () => {
  it('should return null when the input is not an array', () => {
    expect(computeBestSet(null)).toBeNull();
  });

  it('should return null for an empty list', () => {
    expect(computeBestSet([])).toBeNull();
  });

  it('should return null when no set is completed', () => {
    const sets = [makeSet({ completed: false }), makeSet({ setNumber: 2, completed: false })];

    expect(computeBestSet(sets)).toBeNull();
  });

  it('should ignore completed sets without load or repetitions', () => {
    const sets = [makeSet({ load: null }), makeSet({ setNumber: 2, repetitions: null })];

    expect(computeBestSet(sets)).toBeNull();
  });

  it('should pick the completed set with the highest load times repetitions', () => {
    const sets = [
      makeSet({ setNumber: 1, load: 60, repetitions: 10 }),
      makeSet({ setNumber: 2, load: 80, repetitions: 8 }),
      makeSet({ setNumber: 3, load: 100, repetitions: 5 }),
    ];

    expect(computeBestSet(sets)).toEqual({
      setNumber: 2,
      load: 80,
      repetitions: 8,
      duration: null,
      rpe: null,
      restSeconds: null,
      completed: true,
      tonnage: 640,
    });
  });

  it('should skip an incomplete set even when its tonnage is higher', () => {
    const sets = [
      makeSet({ setNumber: 1, load: 50, repetitions: 10 }),
      makeSet({ setNumber: 2, load: 200, repetitions: 10, completed: false }),
    ];

    expect(computeBestSet(sets)).toMatchObject({ setNumber: 1, tonnage: 500 });
  });

  it('should break a tonnage tie by the higher load', () => {
    const sets = [
      makeSet({ setNumber: 1, load: 50, repetitions: 10 }),
      makeSet({ setNumber: 2, load: 100, repetitions: 5 }),
    ];

    expect(computeBestSet(sets)).toMatchObject({ setNumber: 2, load: 100 });
  });

  it('should break a full tie by the lower setNumber', () => {
    const sets = [
      makeSet({ setNumber: 3, load: 50, repetitions: 10 }),
      makeSet({ setNumber: 1, load: 50, repetitions: 10 }),
    ];

    expect(computeBestSet(sets)).toMatchObject({ setNumber: 1 });
  });

  it('should default missing optional fields to null', () => {
    const sets = [{ setNumber: 1, load: 40, repetitions: 12, completed: true }];

    expect(computeBestSet(sets)).toMatchObject({ duration: null, rpe: null, restSeconds: null });
  });
});

describe('resolveEffectiveExerciseId', () => {
  it('should return the substitute exercise id when the log was substituted', () => {
    const log = { exerciseId: EXERCISE_ID, substitutedByExerciseId: SUBSTITUTE_ID };

    expect(resolveEffectiveExerciseId(log)).toBe(SUBSTITUTE_ID);
  });

  it('should return the prescribed exercise id when there is no substitute', () => {
    const log = { exerciseId: EXERCISE_ID, substitutedByExerciseId: null };

    expect(resolveEffectiveExerciseId(log)).toBe(EXERCISE_ID);
  });
});

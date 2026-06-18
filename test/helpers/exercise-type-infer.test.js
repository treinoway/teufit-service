import { describe, it, expect } from 'vitest';
import { inferExerciseType } from '../../src/helpers/exercise-type-infer.js';
import { ExerciseType } from '../../src/constants/training.js';

describe('inferExerciseType', () => {
  it('classifies stretching titles', () => {
    expect(inferExerciseType('Alongamento de glúteo no solo')).toBe(ExerciseType.STRETCHING);
    expect(inferExerciseType('ALONGAMENTO de psoas')).toBe(ExerciseType.STRETCHING);
  });

  it('classifies mobility titles', () => {
    expect(inferExerciseType('Mobilidade escapular em 4 apoios')).toBe(ExerciseType.MOBILITY);
    expect(inferExerciseType('Rotação torácica em 4 apoios')).toBe(ExerciseType.MOBILITY);
    expect(inferExerciseType('Maomé')).toBe(ExerciseType.MOBILITY);
  });

  it('classifies cardio titles', () => {
    expect(inferExerciseType('Corrida na esteira')).toBe(ExerciseType.CARDIO);
    expect(inferExerciseType('HIIT na bike')).toBe(ExerciseType.CARDIO);
  });

  it('falls back to strength for unmatched titles', () => {
    expect(inferExerciseType('Cadeira extensora')).toBe(ExerciseType.STRENGTH);
    expect(inferExerciseType('Levantamento terra sumo')).toBe(ExerciseType.STRENGTH);
    expect(inferExerciseType('Búlgaro com halter')).toBe(ExerciseType.STRENGTH);
  });

  it('is accent- and case-insensitive', () => {
    expect(inferExerciseType('aerobico')).toBe(ExerciseType.CARDIO);
    expect(inferExerciseType('AERÓBICO intenso')).toBe(ExerciseType.CARDIO);
  });

  it('handles empty / non-string input safely', () => {
    expect(inferExerciseType('')).toBe(ExerciseType.STRENGTH);
    expect(inferExerciseType(null)).toBe(ExerciseType.STRENGTH);
    expect(inferExerciseType(undefined)).toBe(ExerciseType.STRENGTH);
    expect(inferExerciseType(123)).toBe(ExerciseType.STRENGTH);
  });
});

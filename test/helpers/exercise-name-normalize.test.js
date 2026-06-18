import { describe, it, expect } from 'vitest';
import {
  normalizeExerciseName,
  exerciseDedupKey,
} from '../../src/helpers/exercise-name-normalize.js';

describe('normalizeExerciseName', () => {
  it('applies sentence case', () => {
    expect(normalizeExerciseName('Agachamento Livre com Barra')).toBe('Agachamento livre com barra');
    expect(normalizeExerciseName('cadeira EXTENSORA')).toBe('Cadeira extensora');
  });

  it('preserves known proper nouns and acronyms', () => {
    expect(normalizeExerciseName('Afundo no smith')).toBe('Afundo no Smith');
    expect(normalizeExerciseName('RDL romenian deadlift')).toBe('RDL Romenian deadlift');
  });

  it('does not mis-capitalize the second word after a leading acronym', () => {
    // Regression: "RDL Romenian deadlift" must NOT become "RDL ROmenian deadlift".
    expect(normalizeExerciseName('RDL Romenian deadlift')).toBe('RDL Romenian deadlift');
  });

  it('preserves unknown short all-caps acronyms', () => {
    expect(normalizeExerciseName('Treino HIIT')).toBe('Treino HIIT');
  });

  it('collapses whitespace and handles empty input', () => {
    expect(normalizeExerciseName('  Stiff   com  barra ')).toBe('Stiff com barra');
    expect(normalizeExerciseName('')).toBe('');
    expect(normalizeExerciseName(null)).toBe('');
  });
});

describe('exerciseDedupKey', () => {
  it('maps degree-sign variants to the same key', () => {
    expect(exerciseDedupKey('Leg press 45')).toBe(exerciseDedupKey('Leg press 45º'));
  });

  it('maps reordered token variants to the same key', () => {
    expect(exerciseDedupKey('RDL Romenian deadlift')).toBe(
      exerciseDedupKey('Romenian deadlift - RDL'),
    );
  });

  it('ignores connector words', () => {
    expect(exerciseDedupKey('Elevação pélvica na barra')).toBe(
      exerciseDedupKey('Elevação pélvica com barra'),
    );
  });

  it('keeps genuinely different exercises distinct', () => {
    expect(exerciseDedupKey('Agachamento livre')).not.toBe(
      exerciseDedupKey('Agachamento livre com barra'),
    );
    expect(exerciseDedupKey('Afundo no Smith')).not.toBe(
      exerciseDedupKey('Afundo no Smith com step'),
    );
  });
});

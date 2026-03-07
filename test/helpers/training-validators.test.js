import { describe, it, expect } from 'vitest';
import {
  buildError,
  validateWeekDay,
  validateCategory,
  validateBodySegment,
  validateExerciseType,
  validateRepetitions,
  validateProtocolType,
} from '../../src/helpers/training-validators.js';

describe('training-validators', () => {
  describe('buildError', () => {
    it('creates an error with the given message', () => {
      const err = buildError('SOME_CODE', 'something went wrong');

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('something went wrong');
    });

    it('attaches code and default statusCode 400', () => {
      const err = buildError('SOME_CODE', 'msg');

      expect(err.code).toBe('SOME_CODE');
      expect(err.statusCode).toBe(400);
    });

    it('uses the provided statusCode when given', () => {
      const err = buildError('NOT_FOUND', 'not found', 404);

      expect(err.statusCode).toBe(404);
    });
  });

  describe('validateWeekDay', () => {
    it('does not throw when weekDay is undefined or null', () => {
      expect(() => validateWeekDay(undefined)).not.toThrow();
      expect(() => validateWeekDay(null)).not.toThrow();
    });

    it('does not throw for a valid week day', () => {
      expect(() => validateWeekDay('monday')).not.toThrow();
      expect(() => validateWeekDay('friday')).not.toThrow();
    });

    it('accepts all valid week day values', () => {
      const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      for (const day of allDays) {
        expect(() => validateWeekDay(day)).not.toThrow();
      }
    });

    it('throws INVALID_WEEK_DAY for an unrecognised value', () => {
      expect(() => validateWeekDay('funday')).toThrow(
        expect.objectContaining({ code: 'INVALID_WEEK_DAY', statusCode: 400 }),
      );
    });

    it('includes the invalid day in the error message', () => {
      expect(() => validateWeekDay('funday')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('funday') }),
      );
    });

    it('uses custom fieldName in error message when provided', () => {
      expect(() => validateWeekDay('funday', 'weekDay')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('weekDay') }),
      );
    });
  });

  describe('validateCategory', () => {
    it('does not throw for a valid category', () => {
      expect(() => validateCategory('strength')).not.toThrow();
    });

    it('accepts all valid category values', () => {
      const categories = ['strength', 'cardio', 'flexibility', 'rest', 'functional', 'mobility'];
      for (const cat of categories) {
        expect(() => validateCategory(cat)).not.toThrow();
      }
    });

    it('throws INVALID_CATEGORY for an unrecognised value', () => {
      expect(() => validateCategory('yoga')).toThrow(
        expect.objectContaining({ code: 'INVALID_CATEGORY', statusCode: 400 }),
      );
    });

    it('includes the invalid value in the error message', () => {
      expect(() => validateCategory('yoga')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('yoga') }),
      );
    });
  });

  describe('validateBodySegment', () => {
    it('does not throw when bodySegment is undefined', () => {
      expect(() => validateBodySegment(undefined)).not.toThrow();
    });

    it('does not throw when bodySegment is a valid value', () => {
      expect(() => validateBodySegment('upper')).not.toThrow();
    });

    it('accepts all valid body segment values', () => {
      const segments = ['upper', 'lower', 'core', 'full_body'];
      for (const seg of segments) {
        expect(() => validateBodySegment(seg)).not.toThrow();
      }
    });

    it('throws INVALID_BODY_SEGMENT for an unrecognised value', () => {
      expect(() => validateBodySegment('arms')).toThrow(
        expect.objectContaining({ code: 'INVALID_BODY_SEGMENT', statusCode: 400 }),
      );
    });

    it('includes the invalid value in the error message', () => {
      expect(() => validateBodySegment('arms')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('arms') }),
      );
    });
  });

  describe('validateExerciseType', () => {
    it('does not throw for a valid exercise type', () => {
      expect(() => validateExerciseType('strength')).not.toThrow();
      expect(() => validateExerciseType('cardio')).not.toThrow();
    });

    it('accepts all valid exercise type values', () => {
      const types = ['strength', 'cardio', 'mobility', 'stretching'];
      for (const type of types) {
        expect(() => validateExerciseType(type)).not.toThrow();
      }
    });

    it('throws INVALID_EXERCISE_TYPE for an unrecognised value', () => {
      expect(() => validateExerciseType('yoga')).toThrow(
        expect.objectContaining({ code: 'INVALID_EXERCISE_TYPE', statusCode: 400 }),
      );
    });

    it('includes the invalid value in the error message', () => {
      expect(() => validateExerciseType('yoga')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('yoga') }),
      );
    });

    it('throws when type is empty or undefined (required)', () => {
      expect(() => validateExerciseType('')).toThrow(expect.objectContaining({ code: 'INVALID_EXERCISE_TYPE' }));
    });
  });

  describe('validateRepetitions', () => {
    it('does not throw when called with null', () => {
      expect(() => validateRepetitions(null)).not.toThrow();
    });

    it('does not throw when called with undefined', () => {
      expect(() => validateRepetitions(undefined)).not.toThrow();
    });

    it('does not throw for a valid { min, max } object', () => {
      expect(() => validateRepetitions({ min: 8, max: 12 })).not.toThrow();
    });

    it('does not throw when min equals max (fixed rep count)', () => {
      expect(() => validateRepetitions({ min: 10, max: 10 })).not.toThrow();
    });

    it('throws INVALID_REPETITIONS when min is 0', () => {
      expect(() => validateRepetitions({ min: 0, max: 10 })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('throws INVALID_REPETITIONS when min is a float', () => {
      expect(() => validateRepetitions({ min: 1.5, max: 10 })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('throws INVALID_REPETITIONS when min is undefined', () => {
      expect(() => validateRepetitions({ min: undefined, max: 10 })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('throws INVALID_REPETITIONS when max is 0', () => {
      expect(() => validateRepetitions({ min: 1, max: 0 })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('throws INVALID_REPETITIONS when max is a float', () => {
      expect(() => validateRepetitions({ min: 1, max: 12.5 })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('throws INVALID_REPETITIONS when max is undefined', () => {
      expect(() => validateRepetitions({ min: 1, max: undefined })).toThrow(
        expect.objectContaining({ code: 'INVALID_REPETITIONS', statusCode: 400 }),
      );
    });

    it('error message mentions repetitions.min when min is invalid', () => {
      expect(() => validateRepetitions({ min: -1, max: 10 })).toThrow(
        expect.objectContaining({ message: expect.stringContaining('repetitions.min') }),
      );
    });

    it('error message mentions repetitions.max when max is invalid', () => {
      expect(() => validateRepetitions({ min: 1, max: -1 })).toThrow(
        expect.objectContaining({ message: expect.stringContaining('repetitions.max') }),
      );
    });
  });

  describe('validateProtocolType', () => {
    it('does not throw when type is undefined or null', () => {
      expect(() => validateProtocolType(undefined)).not.toThrow();
      expect(() => validateProtocolType(null)).not.toThrow();
    });

    it('does not throw for a valid protocol type', () => {
      expect(() => validateProtocolType('strength')).not.toThrow();
      expect(() => validateProtocolType('cardio')).not.toThrow();
    });

    it('accepts all valid protocol type values', () => {
      const types = ['strength', 'cardio', 'stretching', 'mobility', 'activation'];
      for (const type of types) {
        expect(() => validateProtocolType(type)).not.toThrow();
      }
    });

    it('throws INVALID_PROTOCOL_TYPE for an unrecognised value', () => {
      expect(() => validateProtocolType('yoga')).toThrow(
        expect.objectContaining({ code: 'INVALID_PROTOCOL_TYPE', statusCode: 400 }),
      );
    });

    it('includes the invalid value in the error message', () => {
      expect(() => validateProtocolType('pilates')).toThrow(
        expect.objectContaining({ message: expect.stringContaining('pilates') }),
      );
    });
  });
});

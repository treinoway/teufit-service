import { describe, it, expect } from 'vitest';
import {
  buildError,
  validateWeekDays,
  validateCategory,
  validateBodySegment,
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

  describe('validateWeekDays', () => {
    it('does not throw for a valid array of week days', () => {
      expect(() => validateWeekDays(['monday', 'friday'])).not.toThrow();
    });

    it('does not throw for an empty array', () => {
      expect(() => validateWeekDays([])).not.toThrow();
    });

    it('throws INVALID_WEEK_DAYS when value is not an array', () => {
      expect(() => validateWeekDays('monday')).toThrow(
        expect.objectContaining({ code: 'INVALID_WEEK_DAYS', statusCode: 400 }),
      );
    });

    it('uses default fieldName in error message when not provided', () => {
      expect(() => validateWeekDays(null)).toThrow(
        expect.objectContaining({ message: 'weekDays must be an array' }),
      );
    });

    it('uses custom fieldName in error message when provided', () => {
      expect(() => validateWeekDays(null, 'availableWeekDays')).toThrow(
        expect.objectContaining({ message: 'availableWeekDays must be an array' }),
      );
    });

    it('throws INVALID_WEEK_DAYS when array contains invalid day values', () => {
      expect(() => validateWeekDays(['monday', 'funday'])).toThrow(
        expect.objectContaining({ code: 'INVALID_WEEK_DAYS' }),
      );
    });

    it('includes the invalid day in the error message', () => {
      expect(() => validateWeekDays(['funday'])).toThrow(
        expect.objectContaining({ message: expect.stringContaining('funday') }),
      );
    });

    it('accepts all valid week day values', () => {
      const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      expect(() => validateWeekDays(allDays)).not.toThrow();
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
});

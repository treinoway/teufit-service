import { describe, expect, it } from 'vitest';
import { parseBool } from '../../src/helpers/env.js';

describe('parseBool', () => {
  describe('unrecognized / empty input falls back to defaultValue', () => {
    it('returns defaultValue when value is undefined', () => {
      expect(parseBool(undefined, true)).toBe(true);
      expect(parseBool(undefined, false)).toBe(false);
    });

    it('returns defaultValue when value is null', () => {
      expect(parseBool(null, true)).toBe(true);
      expect(parseBool(null, false)).toBe(false);
    });

    it('returns defaultValue when value is not a string (e.g. a number or boolean)', () => {
      expect(parseBool(1, false)).toBe(false);
      expect(parseBool(true, false)).toBe(false);
    });

    it('returns defaultValue when value is an empty string', () => {
      expect(parseBool('', true)).toBe(true);
      expect(parseBool('', false)).toBe(false);
    });

    it('returns defaultValue when value is whitespace-only', () => {
      expect(parseBool('   ', true)).toBe(true);
      expect(parseBool('   ', false)).toBe(false);
    });

    it('returns defaultValue when value is an unrecognized string', () => {
      expect(parseBool('maybe', true)).toBe(true);
      expect(parseBool('maybe', false)).toBe(false);
    });
  });

  describe('truthy string values', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON'])(
      'returns true for %j regardless of the defaultValue',
      (value) => {
        expect(parseBool(value, false)).toBe(true);
        expect(parseBool(value, true)).toBe(true);
      },
    );

    it('trims surrounding whitespace before matching a truthy value', () => {
      expect(parseBool(' YES ', false)).toBe(true);
      expect(parseBool('\ttrue\n', false)).toBe(true);
    });
  });

  describe('falsy string values', () => {
    it.each(['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF'])(
      'returns false for %j regardless of the defaultValue',
      (value) => {
        expect(parseBool(value, true)).toBe(false);
        expect(parseBool(value, false)).toBe(false);
      },
    );

    it('trims surrounding whitespace before matching a falsy value', () => {
      expect(parseBool(' NO ', true)).toBe(false);
      expect(parseBool('\tfalse\n', true)).toBe(false);
    });
  });
});

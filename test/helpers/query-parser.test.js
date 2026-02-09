import { describe, it, expect } from 'vitest';
import { parseIncludeParameter } from '../../src/helpers/query-parser.js';

describe('parseIncludeParameter', () => {
  const allowedRelations = new Set(['address', 'socials', 'preferences']);

  describe('empty or undefined parameter', () => {
    it('returns empty array when parameter is undefined', () => {
      const result = parseIncludeParameter(undefined, allowedRelations);

      expect(result.relations).toEqual([]);
      expect(result.invalid).toEqual([]);
    });

    it('returns empty array when parameter is empty string', () => {
      const result = parseIncludeParameter('', allowedRelations);

      expect(result.relations).toEqual([]);
      expect(result.invalid).toEqual([]);
    });
  });

  describe('single relation', () => {
    it('parses single valid relation', () => {
      const result = parseIncludeParameter('address', allowedRelations);

      expect(result.relations).toEqual(['address']);
      expect(result.invalid).toEqual([]);
    });

    it('returns invalid relation in invalid array', () => {
      const result = parseIncludeParameter('accounts', allowedRelations);

      expect(result.relations).toEqual([]);
      expect(result.invalid).toEqual(['accounts']);
    });
  });

  describe('multiple relations', () => {
    it('parses comma-separated valid relations', () => {
      const result = parseIncludeParameter('address,socials', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });

    it('parses all allowed relations', () => {
      const result = parseIncludeParameter('address,socials,preferences', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials', 'preferences']);
      expect(result.invalid).toEqual([]);
    });

    it('separates valid and invalid relations', () => {
      const result = parseIncludeParameter('address,accounts,socials', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual(['accounts']);
    });

    it('handles multiple invalid relations', () => {
      const result = parseIncludeParameter('accounts,refreshTokens,address', allowedRelations);

      expect(result.relations).toEqual(['address']);
      expect(result.invalid).toEqual(['accounts', 'refreshTokens']);
    });
  });

  describe('whitespace handling', () => {
    it('trims whitespace around relation names', () => {
      const result = parseIncludeParameter(' address , socials ', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });

    it('handles excessive whitespace', () => {
      const result = parseIncludeParameter('  address  ,  socials  ,  preferences  ', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials', 'preferences']);
      expect(result.invalid).toEqual([]);
    });

    it('filters out empty strings from consecutive commas', () => {
      const result = parseIncludeParameter('address,,socials', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });
  });

  describe('duplicate handling', () => {
    it('removes duplicate valid relations', () => {
      const result = parseIncludeParameter('address,socials,address', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });

    it('removes duplicate invalid relations', () => {
      const result = parseIncludeParameter('accounts,accounts,address', allowedRelations);

      expect(result.relations).toEqual(['address']);
      expect(result.invalid).toEqual(['accounts']);
    });

    it('removes duplicates from both valid and invalid', () => {
      const result = parseIncludeParameter('address,address,accounts,accounts,socials', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual(['accounts']);
    });
  });

  describe('edge cases', () => {
    it('handles only invalid relations', () => {
      const result = parseIncludeParameter('accounts,refreshTokens', allowedRelations);

      expect(result.relations).toEqual([]);
      expect(result.invalid).toEqual(['accounts', 'refreshTokens']);
    });

    it('handles trailing comma', () => {
      const result = parseIncludeParameter('address,socials,', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });

    it('handles leading comma', () => {
      const result = parseIncludeParameter(',address,socials', allowedRelations);

      expect(result.relations).toEqual(['address', 'socials']);
      expect(result.invalid).toEqual([]);
    });

    it('handles single comma', () => {
      const result = parseIncludeParameter(',', allowedRelations);

      expect(result.relations).toEqual([]);
      expect(result.invalid).toEqual([]);
    });
  });
});

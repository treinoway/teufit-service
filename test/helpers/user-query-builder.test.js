import { describe, it, expect } from 'vitest';
import { buildUserSelect } from '../../src/helpers/user-query-builder.js';

describe('buildUserSelect', () => {
  describe('base fields', () => {
    it('always includes base user fields when no relations are requested', () => {
      const select = buildUserSelect([]);

      expect(select).toHaveProperty('id', true);
      expect(select).toHaveProperty('email', true);
      expect(select).toHaveProperty('roles', true);
      expect(select).toHaveProperty('status', true);
      expect(select).toHaveProperty('firstName', true);
      expect(select).toHaveProperty('lastName', true);
      expect(select).toHaveProperty('gender', true);
      expect(select).toHaveProperty('birthDate', true);
      expect(select).toHaveProperty('avatarUrl', true);
    });

    it('always includes base fields even with relations', () => {
      const select = buildUserSelect(['address', 'socials', 'preferences']);

      // Base fields still present
      expect(select).toHaveProperty('id', true);
      expect(select).toHaveProperty('email', true);
      expect(select).toHaveProperty('roles', true);
    });
  });

  describe('no relations', () => {
    it('does not include any relations when empty array is passed', () => {
      const select = buildUserSelect([]);

      expect(select).not.toHaveProperty('address');
      expect(select).not.toHaveProperty('socials');
      expect(select).not.toHaveProperty('preferences');
    });

    it('does not include relations when default parameter is used', () => {
      const select = buildUserSelect();

      expect(select).not.toHaveProperty('address');
      expect(select).not.toHaveProperty('socials');
      expect(select).not.toHaveProperty('preferences');
    });
  });

  describe('address relation', () => {
    it('includes address when requested', () => {
      const select = buildUserSelect(['address']);

      expect(select).toHaveProperty('address');
      expect(select.address).toHaveProperty('select');
      expect(select.address.select).toHaveProperty('id', true);
      expect(select.address.select).toHaveProperty('line1', true);
      expect(select.address.select).toHaveProperty('line2', true);
      expect(select.address.select).toHaveProperty('neighborhood', true);
      expect(select.address.select).toHaveProperty('city', true);
      expect(select.address.select).toHaveProperty('state', true);
      expect(select.address.select).toHaveProperty('stateCode', true);
      expect(select.address.select).toHaveProperty('country', true);
      expect(select.address.select).toHaveProperty('countryCode', true);
      expect(select.address.select).toHaveProperty('postalCode', true);
    });

    it('does not include address when not requested', () => {
      const select = buildUserSelect(['socials']);

      expect(select).not.toHaveProperty('address');
    });
  });

  describe('socials relation', () => {
    it('includes socials when requested', () => {
      const select = buildUserSelect(['socials']);

      expect(select).toHaveProperty('socials');
      expect(select.socials).toHaveProperty('select');
      expect(select.socials.select).toHaveProperty('id', true);
      expect(select.socials.select).toHaveProperty('instagram', true);
      expect(select.socials.select).toHaveProperty('whatsapp', true);
      expect(select.socials.select).toHaveProperty('x', true);
      expect(select.socials.select).toHaveProperty('threads', true);
      expect(select.socials.select).toHaveProperty('youtube', true);
      expect(select.socials.select).toHaveProperty('linkedin', true);
      expect(select.socials.select).toHaveProperty('facebook', true);
    });

    it('does not include socials when not requested', () => {
      const select = buildUserSelect(['address']);

      expect(select).not.toHaveProperty('socials');
    });
  });

  describe('preferences relation', () => {
    it('includes preferences when requested', () => {
      const select = buildUserSelect(['preferences']);

      expect(select).toHaveProperty('preferences');
      expect(select.preferences).toHaveProperty('select');
      expect(select.preferences.select).toHaveProperty('activeProfile', true);
      expect(select.preferences.select).toHaveProperty('rawPreferences', true);
    });

    it('does not include preferences when not requested', () => {
      const select = buildUserSelect(['address']);

      expect(select).not.toHaveProperty('preferences');
    });
  });

  describe('multiple relations', () => {
    it('includes address and socials when both are requested', () => {
      const select = buildUserSelect(['address', 'socials']);

      expect(select).toHaveProperty('address');
      expect(select).toHaveProperty('socials');
      expect(select).not.toHaveProperty('preferences');
    });

    it('includes all relations when all are requested', () => {
      const select = buildUserSelect(['address', 'socials', 'preferences']);

      expect(select).toHaveProperty('address');
      expect(select).toHaveProperty('socials');
      expect(select).toHaveProperty('preferences');
    });

    it('only includes requested relations from mixed array', () => {
      const select = buildUserSelect(['address', 'preferences']);

      expect(select).toHaveProperty('address');
      expect(select).toHaveProperty('preferences');
      expect(select).not.toHaveProperty('socials');
    });
  });

  describe('unknown relations', () => {
    it('ignores unknown relation names', () => {
      const select = buildUserSelect(['address', 'unknown', 'accounts']);

      // Only address is valid and known to the builder
      expect(select).toHaveProperty('address');
      expect(select).not.toHaveProperty('unknown');
      expect(select).not.toHaveProperty('accounts');
    });

    it('returns only base fields when only unknown relations are requested', () => {
      const select = buildUserSelect(['unknown', 'invalid']);

      // Only base fields, no relations
      expect(select).toHaveProperty('id');
      expect(select).not.toHaveProperty('unknown');
      expect(select).not.toHaveProperty('invalid');
    });
  });

  describe('query structure', () => {
    it('creates correct nested Prisma select structure', () => {
      const select = buildUserSelect(['address']);

      // Verify Prisma select structure
      expect(select.address).toEqual({
        select: {
          id: true,
          line1: true,
          line2: true,
          neighborhood: true,
          city: true,
          state: true,
          stateCode: true,
          country: true,
          countryCode: true,
          postalCode: true,
        },
      });
    });

    it('creates valid Prisma query for multiple relations', () => {
      const select = buildUserSelect(['address', 'socials']);

      // Both should have nested select structure
      expect(select.address).toHaveProperty('select');
      expect(select.socials).toHaveProperty('select');
      expect(typeof select.address.select).toBe('object');
      expect(typeof select.socials.select).toBe('object');
    });
  });
});

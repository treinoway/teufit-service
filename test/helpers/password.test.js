import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { hashPassword, verifyPassword, verifyAgainstDummyHash, resolveScryptCost } from '../../src/helpers/password.js';

const PASSWORD = 'password123';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

describe('password helpers', () => {
  describe('hashPassword / verifyPassword', () => {
    it('should round-trip a password through the scrypt format', () => {
      const stored = hashPassword(PASSWORD);

      expect(stored).toMatch(/^scrypt\$N=16384,r=8,p=1\$[^$]+\$[^$]+$/);
      expect(verifyPassword(PASSWORD, stored)).toBe(true);
    });

    it('should salt every hash', () => {
      expect(hashPassword(PASSWORD)).not.toBe(hashPassword(PASSWORD));
    });

    it('should reject a wrong password', () => {
      expect(verifyPassword('wrong-password', hashPassword(PASSWORD))).toBe(false);
    });

    it.each([null, undefined, '', 'bcrypt$abc', 'scrypt$N=1$only-three-parts', 'scrypt$N=0,r=8,p=1$c2FsdA==$aGFzaA=='])(
      'should reject a malformed stored hash (%s)',
      (stored) => {
        expect(verifyPassword(PASSWORD, stored)).toBe(false);
      },
    );
  });

  describe('verifyAgainstDummyHash', () => {
    it('should always return false', () => {
      expect(verifyAgainstDummyHash(PASSWORD)).toBe(false);
      expect(verifyAgainstDummyHash(undefined)).toBe(false);
    });

    it('should run exactly one scrypt with the same parameters as a real check', () => {
      const scryptSpy = vi.spyOn(crypto, 'scryptSync');

      verifyAgainstDummyHash(PASSWORD);

      expect(scryptSpy).toHaveBeenCalledTimes(1);
      expect(scryptSpy.mock.calls[0][2]).toBe(64);
      expect(scryptSpy.mock.calls[0][3]).toEqual(SCRYPT_PARAMS);
    });
  });

  describe('resolveScryptCost', () => {
    it('should use the default cost when no override is set', () => {
      expect(resolveScryptCost({ NODE_ENV: 'test' })).toBe(16384);
    });

    it('should honor PASSWORD_SCRYPT_COST under NODE_ENV=test', () => {
      expect(resolveScryptCost({ NODE_ENV: 'test', PASSWORD_SCRYPT_COST: '1024' })).toBe(1024);
    });

    it.each(['production', 'staging', 'development', undefined])(
      'should ignore PASSWORD_SCRYPT_COST outside tests (NODE_ENV=%s)',
      (nodeEnv) => {
        expect(resolveScryptCost({ NODE_ENV: nodeEnv, PASSWORD_SCRYPT_COST: '1024' })).toBe(16384);
      },
    );

    it.each(['abc', '0', '1', '1000', '-1024', '1024.5'])(
      'should fall back to the default for an invalid cost (%s)',
      (cost) => {
        expect(resolveScryptCost({ NODE_ENV: 'test', PASSWORD_SCRYPT_COST: cost })).toBe(16384);
      },
    );

    it('should still verify a hash made with a different cost', () => {
      const salt = crypto.randomBytes(16);
      const derived = crypto.scryptSync(PASSWORD, salt, 64, { N: 1024, r: 8, p: 1 });
      const stored = `scrypt$N=1024,r=8,p=1$${salt.toString('base64')}$${derived.toString('base64')}`;

      expect(verifyPassword(PASSWORD, stored)).toBe(true);
    });
  });
});

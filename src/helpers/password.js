import crypto from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });

/**
 * Hashes a password with scrypt into a self-contained string:
 * `scrypt$N=...,r=...,p=...$<saltB64>$<hashB64>`.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, { N, r, p });
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

function parseScryptParams(paramsPart) {
  return Object.fromEntries(
    paramsPart
      .split(',')
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2)
      .map(([key, value]) => [key, Number(value)]),
  );
}

/** Constant-time check of a password against a hash from hashPassword(). */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;

  const parts = stored.split('$');
  if (parts.length !== 4) return false;

  const { N, r, p } = parseScryptParams(parts[1]);
  if (![N, r, p].every((n) => Number.isFinite(n) && n > 0)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(derived, expected);
}

// Computed once at load, so the first unknown-email login is not slower than the rest.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(32).toString('base64'));

/**
 * Burns the same scrypt cost as a real password check, for login paths that
 * have no hash to compare against (unknown email, OAuth-only account). Without
 * it those paths answer measurably faster and reveal which emails have an
 * account. Always returns false.
 */
export function verifyAgainstDummyHash(password) {
  verifyPassword(typeof password === 'string' ? password : '', DUMMY_PASSWORD_HASH);
  return false;
}

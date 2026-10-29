import crypto from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;
// PASSWORD_SCRYPT_COST lowers N only under NODE_ENV=test (the e2e suite hashes
// hundreds of passwords), so a stray env var can never weaken production hashes.
// Verification reads N from the stored hash, so hashes of any cost still verify.
const DEFAULT_SCRYPT_COST = 16384;
const SCRYPT_PARAMS = Object.freeze({ N: resolveScryptCost(process.env), r: 8, p: 1 });

/**
 * Scrypt cost (N) for new hashes: PASSWORD_SCRYPT_COST under NODE_ENV=test, else the default.
 * @param {Record<string, string|undefined>} env
 * @returns {number}
 */
export function resolveScryptCost(env) {
  if (env.NODE_ENV !== 'test' || !env.PASSWORD_SCRYPT_COST) return DEFAULT_SCRYPT_COST;
  const cost = Number(env.PASSWORD_SCRYPT_COST);
  const isPowerOfTwo = Number.isInteger(cost) && cost > 1 && (cost & (cost - 1)) === 0;
  return isPowerOfTwo ? cost : DEFAULT_SCRYPT_COST;
}

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

// LOAD-BEARING: this module must stay dependency-free (no imports from
// config/ or elsewhere in src/). config/environments/default.js imports
// `parseBool` from here, and config/index.js is a top-level-await module
// imported by nearly everything else — if this file ever imports something
// that transitively reaches config/index.js, that becomes a circular import
// with a hard-to-debug failure mode (a partially-initialized config where
// `betaInviteGate?.enabled === false` silently evaluates false, leaving the
// beta gate stuck on). src/helpers/beta-access.js already imports config/
// the other direction, so this is the only edge allowed to point config/ ->
// src/ — keep it that way.
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Parses an env var string as a boolean, tolerant of how humans actually type
 * values into a dashboard (Railway, etc.) — case-insensitive, trimmed, and
 * accepting true/false, 1/0, yes/no, on/off. Anything unset, empty, or not
 * recognized falls back to `defaultValue` rather than silently taking a side.
 *
 * Prefer this over `process.env.X === 'true'` / `!== 'false'` for any env var
 * that is unambiguously a boolean switch — those raw comparisons treat
 * "FALSE", "False", "0", " false" (a stray trailing space) etc. as the
 * opposite of what the operator intended, with no error or warning.
 *
 * @param {string|undefined|null} value - Raw env var value (e.g. process.env.X)
 * @param {boolean} defaultValue - Value to use when unset/empty/unrecognized
 * @returns {boolean}
 */
export function parseBool(value, defaultValue) {
  if (typeof value !== 'string') return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return defaultValue;
}

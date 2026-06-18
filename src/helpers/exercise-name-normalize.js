/**
 * Helpers to normalize free-form exercise names (e.g. raw YouTube titles) into a
 * consistent catalog form, and to detect near-duplicate names.
 */

// Tokens that keep a fixed canonical casing (proper nouns / acronyms).
const CANONICAL_TOKENS = new Map([
  ['smith', 'Smith'],
  ['rdl', 'RDL'],
  ['romenian', 'Romenian'],
  ['hiit', 'HIIT'],
]);

// Connector words that do NOT change the identity of an exercise. Used only for
// near-duplicate detection (NOT for display).
const STOPWORDS = new Set(['de', 'do', 'da', 'no', 'na', 'em', 'com', 'e', 'a', 'o', '-']);

function stripDiacritics(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Convert a raw exercise title to sentence case, preserving acronyms and known
 * proper nouns. Collapses whitespace and trims.
 *
 * - All-caps short tokens (len ≤ 4, e.g. "RDL") keep their uppercase form.
 * - Known proper nouns (Smith, Romenian…) get their canonical casing.
 * - Otherwise: first letter of the whole string uppercased, rest lowercased.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeExerciseName(title) {
  if (!title || typeof title !== 'string') return '';
  const words = title.trim().replace(/\s+/g, ' ').split(' ');

  const normalized = words.map((word) => {
    const lower = word.toLowerCase();
    if (CANONICAL_TOKENS.has(lower)) return CANONICAL_TOKENS.get(lower);
    // Preserve original short all-caps acronyms (RDL, etc.) not in the map.
    if (/^[A-ZÀ-Ý]{2,4}$/.test(word)) return word;
    return lower;
  });

  // Sentence case: uppercase only the very first character of the string.
  // (Searching for the first lowercase letter would wrongly capitalize the 2nd
  // word when the 1st is an acronym, e.g. "RDL Romenian" → "RDL ROmenian".)
  const out = normalized.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Build a canonical key for near-duplicate detection: accent-stripped, lowercased,
 * connector words and the degree sign removed, remaining tokens sorted. Two names
 * that describe the same exercise (e.g. "Leg press 45" / "Leg press 45º",
 * "RDL Romenian deadlift" / "Romenian deadlift - RDL") map to the same key.
 *
 * @param {string} name
 * @returns {string}
 */
export function exerciseDedupKey(name) {
  const tokens = stripDiacritics(String(name).toLowerCase())
    .replace(/º|°/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t));
  return [...tokens].sort().join(' ');
}

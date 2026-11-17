import { Prisma } from '@prisma/client';
import { FoodSource } from '../constants/nutrition.js';

const LIKE_SPECIAL_CHARS = /[\\%_]/g;
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const WORD_BOUNDARY = String.raw`\y`;
const COMPOSITE_MARKERS = String.raw`(^|[^[:alnum:]])c/|\ycom\y|\(`;
const NON_ALPHANUMERIC_RUN = '[^[:alnum:]]+';
const NORMALIZED_NAME = Prisma.sql`unaccent(lower(f.name))`;
const SOURCE_PREFERENCE = [FoodSource.CUSTOM, FoodSource.TACO, FoodSource.TBCA];

// Escapes LIKE wildcards of user input.
export function escapeLike(text) {
  return text.replace(LIKE_SPECIAL_CHARS, (char) => `\\${char}`);
}

// Escapes regex metacharacters of user input.
export function escapeRegex(text) {
  return text.replace(REGEX_SPECIAL_CHARS, (char) => `\\${char}`);
}

// Splits a query in whitespace-separated tokens.
export function tokenize(query) {
  return (query ?? '').split(/\s+/).filter(Boolean);
}

// SQL boolean: the name matches the token as a whole word.
function wholeWordMatch(token) {
  const pattern = `${WORD_BOUNDARY}${escapeRegex(token)}${WORD_BOUNDARY}`;
  return Prisma.sql`${NORMALIZED_NAME} ~ unaccent(lower(${pattern}::text))`;
}

// SQL boolean: the name starts with the first query token.
function startsWithFirstToken(firstToken) {
  return Prisma.sql`${NORMALIZED_NAME} LIKE unaccent(lower(${`${escapeLike(firstToken)}%`}::text))`;
}

// SQL integer: number of words in the name.
function nameWordCount() {
  return Prisma.sql`cardinality(string_to_array(btrim(regexp_replace(${NORMALIZED_NAME}, ${NON_ALPHANUMERIC_RUN}::text, ' ', 'g')), ' '))`;
}

// SQL integer: position of the food source in the preference list (custom, taco, tbca).
function sourceRank() {
  const branches = SOURCE_PREFERENCE.map((source, index) => Prisma.sql`WHEN ${source}::text THEN ${index}::int`);
  return Prisma.sql`CASE f.source ${Prisma.join(branches, ' ')} ELSE ${SOURCE_PREFERENCE.length}::int END`;
}

/**
 * ORDER BY clause ranking simple foods above composite dishes for a search query.
 *
 * @param {string|undefined} query
 * @returns {import('@prisma/client').Prisma.Sql}
 */
export function buildRelevanceOrder(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return Prisma.sql`ORDER BY f.name ASC`;
  const allWholeWords = Prisma.join(tokens.map(wholeWordMatch), ' AND ');
  return Prisma.sql`ORDER BY
    (${startsWithFirstToken(tokens[0])}) DESC,
    (${allWholeWords}) DESC,
    ${nameWordCount()} ASC,
    char_length(f.name) ASC,
    (${NORMALIZED_NAME} ~ ${COMPOSITE_MARKERS}::text) ASC,
    ${sourceRank()} ASC,
    f.name ASC`;
}

import { Prisma } from "@prisma/client";
import { exerciseDedupKey } from "./exercise-name-normalize.js";

const MAX_QUERY_TOKENS = 8;
const MIN_PREFIX_CHARS = 4;
const ACCENT_CLASSES = { a: "[aáàâãä]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]" };

// Reduces an exercise word to a stem so simple Portuguese plurals compare equal ("halteres" -> "halter").
function stemToken(token) {
  if (token.length > 4 && /(oes|aes)$/.test(token)) return `${token.slice(0, -3)}ao`;
  if (token.length > 5 && /(res|zes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

// Significant stems of a name: accent-free, connector words and one-letter tokens dropped.
export function exerciseSearchTokens(name) {
  const key = exerciseDedupKey(name);
  const stems = key.split(" ").filter((t) => t.length > 1).map(stemToken);
  return [...new Set(stems)];
}

// Case-insensitive regex source matching the prefix of a stem with any accent variant.
function accentTolerantPattern(stem) {
  const prefix = stem.length > MIN_PREFIX_CHARS ? stem.slice(0, Math.max(MIN_PREFIX_CHARS, stem.length - 2)) : stem;
  return [...prefix].map((ch) => ACCENT_CLASSES[ch] ?? ch).join("");
}

// Selects the library templates (own + public, live) sharing at least one stem with the query, best first.
async function fetchCandidates(prismaClient, trainerId, tokens, candidateLimit) {
  const matchTerms = tokens.map((t) => Prisma.sql`(CASE WHEN name ~* ${accentTolerantPattern(t)} THEN 1 ELSE 0 END)`);
  const anyMatch = tokens.map((t) => Prisma.sql`name ~* ${accentTolerantPattern(t)}`);
  return prismaClient.$queryRaw(Prisma.sql`
    SELECT name, type,
      (COALESCE(video_url, '') <> '' OR COALESCE(gif_url, '') <> '') AS "hasMedia",
      (trainer_id = ${trainerId}::uuid) AS "own",
      (${Prisma.join(matchTerms, " + ")}) AS "dbScore"
    FROM exercise_templates
    WHERE deleted_at IS NULL
      AND (trainer_id = ${trainerId}::uuid OR is_public = true)
      AND (${Prisma.join(anyMatch, " OR ")})
    ORDER BY "dbScore" DESC, "hasMedia" DESC, "own" DESC, created_at DESC
    LIMIT ${candidateLimit}
  `);
}

// Scores a candidate against the query stems: shared stems first, then fewer unrelated words.
function relevance(queryStems, candidateName) {
  const candidateStems = new Set(exerciseSearchTokens(candidateName));
  const shared = queryStems.filter((s) => candidateStems.has(s)).length;
  return { shared, extra: candidateStems.size - shared };
}

// Orders candidates: relevance, then media, then own over public.
function compareCandidates(a, b) {
  return (
    b.shared - a.shared ||
    a.extra - b.extra ||
    Number(b.hasMedia) - Number(a.hasMedia) ||
    Number(b.own) - Number(a.own) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Searches own and public library exercises by name, tolerating accents, word order, connectors and plurals (DB prefilter, JS ranking).
 * @param {object} prismaClient - Prisma client or transaction
 * @param {string} trainerId - Trainer whose own templates are included
 * @param {string} query - Free-form exercise name
 * @param {{ maxResults?: number, candidateLimit?: number }} [options]
 * @returns {Promise<Array<{ name: string, type: string, hasMedia: boolean }>>}
 */
export async function searchExerciseLibrary(prismaClient, trainerId, query, { maxResults = 5, candidateLimit = 100 } = {}) {
  const stems = exerciseSearchTokens(query).slice(0, MAX_QUERY_TOKENS);
  if (stems.length === 0) return [];

  const rows = await fetchCandidates(prismaClient, trainerId, stems, candidateLimit);
  const minShared = Math.max(1, Math.ceil(stems.length / 2));
  const seen = new Set();
  return rows
    .map((row) => ({ ...row, ...relevance(stems, row.name) }))
    .filter((row) => row.shared >= minShared)
    .sort(compareCandidates)
    .filter((row) => {
      const key = exerciseDedupKey(row.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults)
    .map(({ name, type, hasMedia }) => ({ name, type, hasMedia: Boolean(hasMedia) }));
}

/**
 * Public exercise catalog built from TeuFit's own YouTube shorts.
 *
 * Two steps, kept apart on purpose:
 *   1. fetch  (network): video id + raw title -> catalog entries, written to a JSON
 *      file that is committed and reviewed (names/types are heuristics, a human
 *      should be able to fix them before they reach a database).
 *   2. import (database): catalog JSON -> public exercise_templates owned by one
 *      platform trainer. No network, dry-run by default, safe to re-run.
 *
 * CLI-only module (see scripts/*-exercise-catalog.js); it is not used by the API.
 */
import { createHash } from 'node:crypto';
import { exerciseTypeValues } from '../../src/constants/training.js';
import { inferExerciseType } from '../../src/helpers/exercise-type-infer.js';
import {
  normalizeExerciseName,
  exerciseDedupKey,
} from '../../src/helpers/exercise-name-normalize.js';

export const CATALOG_SOURCE = 'teufit-youtube';
export const CATALOG_VERSION = 1;

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_URL_PATTERNS = [
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
  /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
  /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
];

/**
 * Extract the 11-char YouTube video id from a URL or a bare id.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function parseYoutubeId(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (YOUTUBE_ID_REGEX.test(value)) return value;
  for (const pattern of YOUTUBE_URL_PATTERNS) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Canonical URL stored in exercise_templates.video_url (same format as the
 * existing catalog seeded by generate-caveira-migration.js).
 *
 * @param {string} youtubeId
 * @returns {string}
 */
export function youtubeWatchUrl(youtubeId) {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/**
 * Deterministic UUID derived from the video id, so re-running the import never
 * duplicates rows and a template deleted in the app stays deleted.
 *
 * @param {string} youtubeId
 * @returns {string}
 */
export function catalogTemplateId(youtubeId) {
  const hex = createHash('sha1').update(`${CATALOG_SOURCE}:${youtubeId}`).digest('hex');
  const chars = hex.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Merge freshly fetched videos into an existing catalog.
 *
 * - New videos get a normalized name and an inferred type.
 * - Videos already in the catalog keep their (possibly hand-edited) name and type;
 *   only the raw title is refreshed.
 * - Entries whose video is no longer fetched are kept: removing an exercise is a
 *   deliberate edit to the JSON, never a side effect of a partial fetch.
 *
 * @param {{ entries?: object[] }|null} existingCatalog
 * @param {{ youtubeId: string, title: string }[]} videos
 * @returns {{ catalog: object, added: number, updated: number }}
 */
export function mergeCatalog(existingCatalog, videos) {
  const entries = [...(existingCatalog?.entries ?? [])].map((entry) => ({ ...entry }));
  const byId = new Map(entries.map((entry) => [entry.youtubeId, entry]));
  let added = 0;
  let updated = 0;

  for (const video of videos) {
    const title = video.title.trim();
    const current = byId.get(video.youtubeId);
    if (current) {
      if (current.title !== title) {
        current.title = title;
        updated += 1;
      }
      continue;
    }
    const entry = {
      youtubeId: video.youtubeId,
      title,
      name: normalizeExerciseName(title),
      type: inferExerciseType(title),
    };
    entries.push(entry);
    byId.set(entry.youtubeId, entry);
    added += 1;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return {
    catalog: { source: CATALOG_SOURCE, version: CATALOG_VERSION, entries },
    added,
    updated,
  };
}

/**
 * Validate a catalog file before touching the database.
 *
 * @param {object} catalog
 * @returns {string[]} human-readable problems (empty when valid)
 */
export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog || !Array.isArray(catalog.entries)) {
    return ['Catalog must be an object with an "entries" array.'];
  }
  const seenIds = new Set();
  catalog.entries.forEach((entry, index) => {
    const where = `entries[${index}]`;
    if (!YOUTUBE_ID_REGEX.test(entry?.youtubeId ?? '')) {
      problems.push(`${where}: invalid youtubeId "${entry?.youtubeId}".`);
    } else if (seenIds.has(entry.youtubeId)) {
      problems.push(`${where}: duplicated youtubeId "${entry.youtubeId}".`);
    } else {
      seenIds.add(entry.youtubeId);
    }
    if (typeof entry?.name !== 'string' || entry.name.trim().length === 0) {
      problems.push(`${where}: name is required.`);
    }
    if (!exerciseTypeValues.includes(entry?.type)) {
      problems.push(
        `${where}: invalid type "${entry?.type}". Allowed: ${exerciseTypeValues.join(', ')}.`,
      );
    }
  });
  return problems;
}

function dedupKey(name, type) {
  return `${type}::${exerciseDedupKey(name)}`;
}

/**
 * Import the catalog as PUBLIC exercise templates owned by one trainer.
 *
 * Decisions per entry (in this order):
 * - `existing`: a row with the deterministic id exists and is active. Left untouched,
 *   so edits made in the app are never overwritten.
 * - `deleted`: that row exists but was soft-deleted. Left deleted on purpose.
 * - `duplicateInCatalog`: an earlier entry in this catalog is the same exercise.
 * - `duplicateOfOwner`: the owner already has an active template for the same
 *   exercise (e.g. created by hand). Skipped to avoid two identical items.
 * - `create`: inserted with is_public = true.
 * Other trainers' public templates with the same name only produce a warning.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ catalog: object, ownerEmail: string, apply?: boolean }} options
 * @returns {Promise<object>} report
 */
export async function importPublicExerciseCatalog(prisma, { catalog, ownerEmail, apply = false }) {
  const problems = validateCatalog(catalog);
  if (problems.length > 0) {
    throw new Error(`Invalid catalog:\n- ${problems.join('\n- ')}`);
  }

  const email = String(ownerEmail ?? '').trim().toLowerCase();
  if (!email) throw new Error('ownerEmail is required.');

  const owner = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      deletedAt: true,
      trainer: { select: { id: true, deletedAt: true } },
    },
  });
  if (!owner || owner.deletedAt) {
    throw new Error(`No active user with email "${email}".`);
  }
  if (!owner.trainer || owner.trainer.deletedAt) {
    throw new Error(`User "${email}" has no active trainer profile to own the templates.`);
  }
  const trainerId = owner.trainer.id;

  const entries = catalog.entries.map((entry) => ({
    ...entry,
    id: catalogTemplateId(entry.youtubeId),
    name: entry.name.trim(),
  }));

  const [rowsById, ownerTemplates, otherPublicTemplates] = await Promise.all([
    prisma.exerciseTemplate.findMany({
      where: { id: { in: entries.map((entry) => entry.id) } },
      select: { id: true, deletedAt: true },
    }),
    prisma.exerciseTemplate.findMany({
      where: { trainerId, deletedAt: null },
      select: { id: true, name: true, type: true },
    }),
    prisma.exerciseTemplate.findMany({
      where: { isPublic: true, deletedAt: null, trainerId: { not: trainerId } },
      select: { name: true, type: true },
    }),
  ]);

  const existingById = new Map(rowsById.map((row) => [row.id, row]));
  const ownerKeys = new Map(
    ownerTemplates.map((template) => [dedupKey(template.name, template.type), template.id]),
  );
  const otherPublicKeys = new Set(
    otherPublicTemplates.map((template) => dedupKey(template.name, template.type)),
  );

  const report = {
    apply,
    trainerId,
    create: [],
    existing: [],
    deleted: [],
    duplicateInCatalog: [],
    duplicateOfOwner: [],
    warnings: [],
    created: 0,
  };
  const catalogKeys = new Set();

  for (const entry of entries) {
    const key = dedupKey(entry.name, entry.type);
    const row = existingById.get(entry.id);
    const summary = { youtubeId: entry.youtubeId, name: entry.name, type: entry.type };

    if (row) {
      report[row.deletedAt ? 'deleted' : 'existing'].push(summary);
      catalogKeys.add(key);
      continue;
    }
    if (catalogKeys.has(key)) {
      report.duplicateInCatalog.push(summary);
      continue;
    }
    catalogKeys.add(key);
    if (ownerKeys.has(key)) {
      report.duplicateOfOwner.push({ ...summary, existingTemplateId: ownerKeys.get(key) });
      continue;
    }
    if (otherPublicKeys.has(key)) {
      report.warnings.push(
        `"${entry.name}" (${entry.type}) is also public under another trainer.`,
      );
    }
    report.create.push({ ...summary, id: entry.id });
  }

  if (apply && report.create.length > 0) {
    const { count } = await prisma.exerciseTemplate.createMany({
      data: report.create.map((entry) => ({
        id: entry.id,
        trainerId,
        name: entry.name,
        type: entry.type,
        videoUrl: youtubeWatchUrl(entry.youtubeId),
        isPublic: true,
      })),
      // A concurrent run inserting the same deterministic id must not fail the batch.
      skipDuplicates: true,
    });
    report.created = count;
  }

  return report;
}

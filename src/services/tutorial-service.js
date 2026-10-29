import { randomUUID } from 'node:crypto';
import { AppError, NotFoundAppError, ValidationAppError } from '../errors/app-error.js';
import { withDeadlockRetry } from '../helpers/db-retry.js';
import { VIDEO_URL_REGEX } from '../constants/video.js';
import {
  TutorialErrorCode,
  TutorialMessageCode,
  TutorialVideoSource,
  TUTORIAL_TITLE_MAX,
  TUTORIAL_DESCRIPTION_MAX,
  TUTORIAL_MAX_VIDEO_BYTES,
  TUTORIAL_KEY_PREFIX,
  TUTORIAL_UPLOAD_URL_EXPIRES_SECONDS,
  TUTORIAL_PLAYBACK_URL_EXPIRES_SECONDS,
  TUTORIAL_MIME_TO_EXTENSION,
} from '../constants/tutorial.js';

const DB_SOURCE_BY_API_SOURCE = Object.freeze({
  [TutorialVideoSource.LINK]: 'LINK',
  [TutorialVideoSource.UPLOAD]: 'UPLOAD',
});

// Builds a 400 validation error for a single field.
function invalidField(field, message) {
  return new ValidationAppError({ message, details: [{ field, message }] });
}

// Builds a 400 domain error with a tutorial messageCode.
function tutorialBadRequest(errorCode, messageCode, message) {
  return new AppError({ httpStatus: 400, error: errorCode, messageCode, message, details: {} });
}

// Throws the 404 used whenever a tutorial id does not exist.
function tutorialNotFound() {
  return new NotFoundAppError({
    error: 'NOT_FOUND',
    messageCode: TutorialMessageCode.NOT_FOUND,
    message: 'Tutorial not found.',
    details: {},
  });
}

// Validates and trims the title.
function parseTitle(title) {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) throw invalidField('title', 'Title is required.');
  if (trimmed.length > TUTORIAL_TITLE_MAX) {
    throw invalidField('title', `Title must be at most ${TUTORIAL_TITLE_MAX} characters.`);
  }
  return trimmed;
}

// Validates and trims the optional description; blank or absent becomes null.
function parseDescription(description) {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') throw invalidField('description', 'Description must be text.');
  const trimmed = description.trim();
  if (trimmed.length > TUTORIAL_DESCRIPTION_MAX) {
    throw invalidField('description', `Description must be at most ${TUTORIAL_DESCRIPTION_MAX} characters.`);
  }
  return trimmed || null;
}

// Validates an http(s) link and returns the trimmed URL.
function parseVideoUrl(videoUrl) {
  const trimmed = typeof videoUrl === 'string' ? videoUrl.trim() : '';
  if (!VIDEO_URL_REGEX.test(trimmed)) {
    throw invalidField('videoUrl', 'Video URL must start with http:// or https://.');
  }
  return trimmed;
}

// Validates that an uploaded video key lives under the tutorials prefix.
function parseVideoKey(videoKey) {
  const isValid = typeof videoKey === 'string'
    && videoKey.startsWith(TUTORIAL_KEY_PREFIX)
    && videoKey.length > TUTORIAL_KEY_PREFIX.length
    && !videoKey.includes('..');
  if (!isValid) {
    throw tutorialBadRequest(
      TutorialErrorCode.INVALID_VIDEO_KEY,
      TutorialMessageCode.INVALID_VIDEO_KEY,
      'Invalid video key.',
    );
  }
  return videoKey;
}

// Converts an API video source and its payload into the stored video columns.
function parseVideoFields({ videoSource, videoUrl, videoKey }) {
  const dbSource = DB_SOURCE_BY_API_SOURCE[videoSource];
  if (!dbSource) throw invalidField('videoSource', 'videoSource must be "link" or "upload".');
  if (videoSource === TutorialVideoSource.LINK) {
    return { videoSource: dbSource, videoUrl: parseVideoUrl(videoUrl), videoKey: null };
  }
  return { videoSource: dbSource, videoUrl: null, videoKey: parseVideoKey(videoKey) };
}

// Maps a stored row to the API shape, resolving uploaded keys to playable URLs.
async function formatTutorial(s3, row, { includeKey }) {
  const isUpload = row.videoSource === 'UPLOAD';
  const videoUrl = isUpload
    ? await s3.resolveUrl(row.videoKey, TUTORIAL_PLAYBACK_URL_EXPIRES_SECONDS)
    : row.videoUrl;
  const formatted = {
    id: row.id,
    title: row.title,
    description: row.description,
    videoSource: isUpload ? TutorialVideoSource.UPLOAD : TutorialVideoSource.LINK,
    videoUrl,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return includeKey ? { ...formatted, videoKey: row.videoKey } : formatted;
}

// Deletes an uploaded file, swallowing failures so they never break the request.
async function deleteFileBestEffort(s3, key) {
  if (!key) return;
  try {
    await s3.deleteFile({ key });
  } catch {
    // why: an orphaned object is harmless, a failed admin request is not
  }
}

/**
 * Rejects an uploaded videoKey already stored on another tutorial (no-op for link sources).
 * @throws {AppError} 400 tutorial.invalidVideoKey when the key belongs to a different tutorial.
 */
export async function assertVideoKeyUnused(db, { videoSource, videoKey }, excludeTutorialId) {
  if (videoSource !== TutorialVideoSource.UPLOAD || typeof videoKey !== 'string') return;
  const where = excludeTutorialId
    ? { videoKey, NOT: { id: excludeTutorialId } }
    : { videoKey };
  const existing = await db.tutorial.findFirst({ where, select: { id: true } });
  if (existing) {
    throw tutorialBadRequest(
      TutorialErrorCode.INVALID_VIDEO_KEY,
      TutorialMessageCode.INVALID_VIDEO_KEY,
      'Invalid video key.',
    );
  }
}

// Returns the order value that places a new tutorial last.
async function nextOrder(db) {
  const { _max } = await db.tutorial.aggregate({ _max: { order: true } });
  return _max.order === null ? 0 : _max.order + 1;
}

/**
 * Creates a tutorial appended at the end of the list.
 * @returns {Promise<object>} The raw stored row (format it with formatTutorialForAdmin).
 */
export async function createTutorial(db, body, adminId) {
  const title = parseTitle(body.title);
  const description = parseDescription(body.description);
  const video = parseVideoFields(body);
  const order = await nextOrder(db);

  return db.tutorial.create({
    data: { title, description, ...video, order, createdById: adminId },
  });
}

// Formats a stored row for admin responses (includes videoKey).
export function formatTutorialForAdmin(s3, row) {
  return formatTutorial(s3, row, { includeKey: true });
}

// Lists all tutorials for admins, ordered, with videoKey.
export async function listTutorials(db, s3) {
  const rows = await db.tutorial.findMany({ orderBy: { order: 'asc' } });
  return Promise.all(rows.map((row) => formatTutorialForAdmin(s3, row)));
}

// Lists all tutorials for trainers, ordered, without videoKey.
export async function listTutorialsForTrainer(db, s3) {
  const rows = await db.tutorial.findMany({ orderBy: { order: 'asc' } });
  return Promise.all(rows.map((row) => formatTutorial(s3, row, { includeKey: false })));
}

// Loads a tutorial row or throws tutorial.notFound.
async function findTutorialOrThrow(db, id) {
  const row = await db.tutorial.findUnique({ where: { id } });
  if (!row) throw tutorialNotFound();
  return row;
}

// Returns one tutorial for admins or throws tutorial.notFound.
export async function getTutorialById(db, s3, id) {
  return formatTutorialForAdmin(s3, await findTutorialOrThrow(db, id));
}

// Builds the partial update data from the fields present in the patch.
function buildUpdateData(patch) {
  const data = {};
  if (patch.title !== undefined) data.title = parseTitle(patch.title);
  if (patch.description !== undefined) data.description = parseDescription(patch.description);
  if (patch.videoSource !== undefined) Object.assign(data, parseVideoFields(patch));
  return data;
}

// Updates title, description and/or video; deletes a replaced uploaded file after the commit.
export async function updateTutorial(db, s3, id, patch) {
  const current = await findTutorialOrThrow(db, id);
  const data = buildUpdateData(patch);

  const updated = await db.tutorial.update({ where: { id }, data });

  const videoKeyReplaced = 'videoKey' in data && current.videoKey && current.videoKey !== data.videoKey;
  if (videoKeyReplaced) await deleteFileBestEffort(s3, current.videoKey);
  return formatTutorialForAdmin(s3, updated);
}

// Deletes a tutorial and, best-effort, its uploaded file.
export async function deleteTutorial(db, s3, id) {
  const current = await findTutorialOrThrow(db, id);
  await db.tutorial.delete({ where: { id } });
  await deleteFileBestEffort(s3, current.videoKey);
}

// Ensures orderedIds is exactly the set of existing tutorial ids, without duplicates.
async function assertExactIdSet(db, orderedIds) {
  const existing = await db.tutorial.findMany({ select: { id: true } });
  const existingIds = new Set(existing.map((row) => row.id));
  const isExactSet = Array.isArray(orderedIds)
    && orderedIds.length === existingIds.size
    && new Set(orderedIds).size === orderedIds.length
    && orderedIds.every((id) => existingIds.has(id));
  if (!isExactSet) {
    throw tutorialBadRequest(
      TutorialErrorCode.INVALID_ORDER,
      TutorialMessageCode.INVALID_ORDER,
      'orderedIds must contain every tutorial id exactly once.',
    );
  }
}

/**
 * Persists a new order (index in orderedIds) for every tutorial.
 * @returns {Promise<object[]>} Raw rows ordered ascending.
 */
export async function reorderTutorials(db, orderedIds) {
  await assertExactIdSet(db, orderedIds);

  // why: updating in sorted id order keeps lock acquisition consistent between concurrent reorders
  const indexById = new Map(orderedIds.map((id, index) => [id, index]));
  const lockOrder = [...orderedIds].sort();
  await withDeadlockRetry(() => db.$transaction(async (tx) => {
    for (const id of lockOrder) {
      await tx.tutorial.update({ where: { id }, data: { order: indexById.get(id) } });
    }
  }));

  return db.tutorial.findMany({ orderBy: { order: 'asc' } });
}

// Validates the declared upload and returns a presigned PUT URL plus the key to store later.
export async function createUploadUrl(s3, { contentType, fileSize }) {
  const extension = Object.hasOwn(TUTORIAL_MIME_TO_EXTENSION, contentType)
    ? TUTORIAL_MIME_TO_EXTENSION[contentType]
    : null;
  if (!extension) {
    throw tutorialBadRequest(
      TutorialErrorCode.INVALID_VIDEO_TYPE,
      TutorialMessageCode.INVALID_VIDEO_TYPE,
      'Unsupported video type. Use MP4, WebM or MOV.',
    );
  }
  if (!Number.isInteger(fileSize) || fileSize <= 0) {
    throw invalidField('fileSize', 'fileSize must be a positive integer.');
  }
  if (fileSize > TUTORIAL_MAX_VIDEO_BYTES) {
    throw tutorialBadRequest(
      TutorialErrorCode.VIDEO_TOO_LARGE,
      TutorialMessageCode.VIDEO_TOO_LARGE,
      'Video exceeds the 500MB limit.',
    );
  }

  const videoKey = `${TUTORIAL_KEY_PREFIX}${randomUUID()}.${extension}`;
  const expiresIn = TUTORIAL_UPLOAD_URL_EXPIRES_SECONDS;
  const uploadUrl = await s3.getSignedPutUrl({ key: videoKey, contentType, expiresIn });
  return { uploadUrl, videoKey, expiresIn };
}

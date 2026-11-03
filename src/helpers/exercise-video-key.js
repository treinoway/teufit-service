import { AppError } from '../errors/app-error.js';
import {
  ExerciseVideoErrorCode,
  ExerciseVideoMessageCode,
  EXERCISE_VIDEO_KEY_PREFIX,
  EXERCISE_VIDEO_KEY_FILENAME_PATTERN,
} from '../constants/exercise-video.js';

// Returns the storage prefix every video key of a trainer must start with.
export function buildTrainerVideoKeyPrefix(trainerId) {
  return `${EXERCISE_VIDEO_KEY_PREFIX}${trainerId}/`;
}

// Tells whether a key is a plain file directly under the trainer's own prefix.
export function isOwnVideoKey(trainerId, key) {
  const prefix = buildTrainerVideoKeyPrefix(trainerId);
  return typeof key === 'string'
    && key.startsWith(prefix)
    && EXERCISE_VIDEO_KEY_FILENAME_PATTERN.test(key.slice(prefix.length))
    && !key.includes('..');
}

// Tells whether a key is shaped like a stored exercise video key (prefix, no traversal).
function isWellFormedVideoKey(key) {
  return key.startsWith(EXERCISE_VIDEO_KEY_PREFIX) && !key.includes('..');
}

/**
 * Rejects a videoFileKey outside the trainer's own prefix; undefined (omitted) and null (clear) pass.
 * @throws {AppError} 400 exerciseVideo.invalidFileKey
 */
export function assertOwnVideoFileKey(trainerId, key) {
  if (key === undefined || key === null) return;
  if (isOwnVideoKey(trainerId, key)) return;
  throw buildInvalidFileKeyError();
}

// Builds the 400 thrown for any video key the trainer may not reference.
function buildInvalidFileKeyError() {
  return new AppError({
    httpStatus: 400,
    error: ExerciseVideoErrorCode.INVALID_FILE_KEY,
    messageCode: ExerciseVideoMessageCode.INVALID_FILE_KEY,
    message: 'Invalid exercise video file key.',
    details: {},
  });
}

/**
 * Rejects a videoFileKey that is neither own-prefixed nor in allowedKeys (stored or loaded-template keys); undefined/null pass.
 * @param {string} trainerId - Trainer id
 * @param {string|null|undefined} key - Caller-supplied key
 * @param {Array<string|null|undefined>} [allowedKeys] - Inherited keys known to be legitimate in this flow
 * @throws {AppError} 400 exerciseVideo.invalidFileKey
 */
export function assertVideoFileKeyAllowed(trainerId, key, allowedKeys = []) {
  if (key === undefined || key === null) return;
  if (typeof key === 'string' && allowedKeys.includes(key) && isWellFormedVideoKey(key)) return;
  assertOwnVideoFileKey(trainerId, key);
}

/**
 * Resolves a stored exercise video key to a signed GET URL; null for absent or foreign-prefix values.
 * @param {{ resolveUrl: (key: string) => Promise<string|null> }} s3 - S3 handler
 * @param {string|null|undefined} key - Stored videoFileKey
 * @returns {Promise<string|null>}
 */
export async function resolveExerciseVideoUrl(s3, key) {
  if (typeof key !== 'string' || !key.startsWith(EXERCISE_VIDEO_KEY_PREFIX)) return null;
  return s3.resolveUrl(key);
}

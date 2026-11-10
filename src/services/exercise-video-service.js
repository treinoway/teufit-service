import { randomUUID } from 'node:crypto';
import { ConflictAppError } from '../errors/app-error.js';
import { buildTrainerVideoKeyPrefix } from '../helpers/exercise-video-key.js';
import {
  EXERCISE_VIDEO_MIME_TO_EXTENSION,
  EXERCISE_VIDEO_UPLOAD_METHOD,
  EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS,
} from '../constants/exercise-video.js';

// Loads the trainer id of the authenticated user or fails with the profile-missing conflict.
async function resolveTrainerId(db, userId) {
  const trainer = await db.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new ConflictAppError({
      message: 'Trainer profile not found',
      messageCode: 'trainer.profileMissing',
    });
  }
  return trainer.id;
}

/**
 * Issues a presigned PUT descriptor so the trainer can upload an exercise video straight to storage.
 * @param {object} db - Prisma client
 * @param {object} s3 - S3 handler exposing getSignedPutUrl
 * @param {string} userId - Authenticated user id
 * @param {{ contentType: string, sizeBytes: number }} body - Already schema-validated upload request
 * @returns {Promise<{ key: string, uploadUrl: string, method: string, headers: object, expiresAt: string }>}
 */
export async function createExerciseVideoUploadUrl(db, s3, userId, { contentType, sizeBytes }) {
  const trainerId = await resolveTrainerId(db, userId);
  const extension = EXERCISE_VIDEO_MIME_TO_EXTENSION[contentType];
  const key = `${buildTrainerVideoKeyPrefix(trainerId)}${randomUUID()}.${extension}`;
  const uploadUrl = await s3.getSignedPutUrl({
    key,
    contentType,
    contentLength: sizeBytes,
    expiresIn: EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS,
  });
  return {
    key,
    uploadUrl,
    method: EXERCISE_VIDEO_UPLOAD_METHOD,
    headers: { 'Content-Type': contentType },
    expiresAt: new Date(Date.now() + EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS * 1000).toISOString(),
  };
}

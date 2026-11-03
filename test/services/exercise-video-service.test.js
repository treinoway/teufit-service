import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExerciseVideoUploadUrl } from '../../src/services/exercise-video-service.js';
import {
  EXERCISE_VIDEO_KEY_PREFIX,
  EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS,
  EXERCISE_VIDEO_UPLOAD_METHOD,
} from '../../src/constants/exercise-video.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const SIGNED_URL = 'https://bucket.example/signed';
const NOW = new Date('2026-11-03T12:00:00.000Z');

describe('exercise-video-service', () => {
  let db;
  let s3;

  beforeEach(() => {
    db = { trainer: { findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }) } };
    s3 = { getSignedPutUrl: vi.fn().mockResolvedValue(SIGNED_URL) };
  });

  describe('createExerciseVideoUploadUrl', () => {
    it.each([
      ['video/mp4', 'mp4'],
      ['video/quicktime', 'mov'],
      ['video/webm', 'webm'],
    ])('should build a trainer-prefixed key with the %s extension', async (contentType, extension) => {
      const result = await createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType, sizeBytes: 10 });

      expect(result.key).toMatch(
        new RegExp(`^${EXERCISE_VIDEO_KEY_PREFIX}${TRAINER_ID}/[0-9a-f-]{36}\\.${extension}$`),
      );
    });

    it('should generate a distinct key on each call', async () => {
      const body = { contentType: 'video/mp4', sizeBytes: 10 };
      const first = await createExerciseVideoUploadUrl(db, s3, USER_ID, body);
      const second = await createExerciseVideoUploadUrl(db, s3, USER_ID, body);

      expect(first.key).not.toBe(second.key);
    });

    it('should look the trainer up by the authenticated user id', async () => {
      await createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/mp4', sizeBytes: 10 });

      expect(db.trainer.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID }, select: { id: true } });
    });

    it('should sign the PUT with key, content type, content length and the 900s TTL', async () => {
      const sizeBytes = 2048;
      const result = await createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/webm', sizeBytes });

      expect(EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS).toBe(900);
      expect(s3.getSignedPutUrl).toHaveBeenCalledWith({
        key: result.key,
        contentType: 'video/webm',
        contentLength: sizeBytes,
        expiresIn: 900,
      });
    });

    it('should return the upload descriptor with method, headers and signed url', async () => {
      const result = await createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/mp4', sizeBytes: 10 });

      expect(result).toMatchObject({
        uploadUrl: SIGNED_URL,
        method: EXERCISE_VIDEO_UPLOAD_METHOD,
        headers: { 'Content-Type': 'video/mp4' },
      });
    });

    describe('expiresAt', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should be an ISO timestamp 900 seconds ahead', async () => {
        const result = await createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/mp4', sizeBytes: 10 });

        expect(result.expiresAt).toBe(new Date(NOW.getTime() + 900 * 1000).toISOString());
      });
    });

    describe('when the user has no trainer profile', () => {
      it('should throw 409 trainer.profileMissing without signing anything', async () => {
        db.trainer.findUnique.mockResolvedValue(null);

        await expect(
          createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/mp4', sizeBytes: 10 }),
        ).rejects.toMatchObject({ httpStatus: 409, messageCode: 'trainer.profileMissing' });
        expect(s3.getSignedPutUrl).not.toHaveBeenCalled();
      });
    });

    describe('when signing fails', () => {
      it('should propagate the storage error', async () => {
        s3.getSignedPutUrl.mockRejectedValue(new Error('s3 down'));

        await expect(
          createExerciseVideoUploadUrl(db, s3, USER_ID, { contentType: 'video/mp4', sizeBytes: 10 }),
        ).rejects.toThrow('s3 down');
      });
    });
  });
});

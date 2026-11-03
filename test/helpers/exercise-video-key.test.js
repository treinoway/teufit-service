import { describe, it, expect, vi } from 'vitest';
import {
  assertOwnVideoFileKey,
  buildTrainerVideoKeyPrefix,
  resolveExerciseVideoUrl,
} from '../../src/helpers/exercise-video-key.js';
import { AppError } from '../../src/errors/app-error.js';
import { ExerciseVideoErrorCode, ExerciseVideoMessageCode } from '../../src/constants/exercise-video.js';

const TRAINER_ID = 'trainer-1';
const OTHER_TRAINER_ID = 'trainer-2';
const OWN_KEY = `exercise-videos/${TRAINER_ID}/abc-123.mp4`;

describe('exercise-video-key', () => {
  describe('buildTrainerVideoKeyPrefix', () => {
    it('should return the exercise-videos prefix scoped to the trainer with a trailing slash', () => {
      expect(buildTrainerVideoKeyPrefix(TRAINER_ID)).toBe('exercise-videos/trainer-1/');
    });
  });

  describe('assertOwnVideoFileKey', () => {
    it.each([
      ['an own-prefix key', OWN_KEY],
      ['an own-prefix key with dots and dashes', `exercise-videos/${TRAINER_ID}/a_b-c.v1.webm`],
      ['undefined (omitted)', undefined],
      ['null (clear)', null],
    ])('should accept %s', (_label, key) => {
      expect(() => assertOwnVideoFileKey(TRAINER_ID, key)).not.toThrow();
    });

    it.each([
      ['another trainer prefix', `exercise-videos/${OTHER_TRAINER_ID}/abc.mp4`],
      ['another storage prefix', `avatars/${TRAINER_ID}/abc.mp4`],
      ['path traversal', `exercise-videos/${TRAINER_ID}/../x`],
      ['traversal escaping to another trainer', `exercise-videos/${TRAINER_ID}/../${OTHER_TRAINER_ID}/abc.mp4`],
      ['dotted traversal inside file name', `exercise-videos/${TRAINER_ID}/a..mp4`],
      ['a nested path', `exercise-videos/${TRAINER_ID}/sub/abc.mp4`],
      ['the bare prefix with no file name', `exercise-videos/${TRAINER_ID}/`],
      ['a prefix lookalike without slash', `exercise-videos/${TRAINER_ID}abc.mp4`],
      ['an empty string', ''],
      ['a file name with unsafe characters', `exercise-videos/${TRAINER_ID}/a b.mp4`],
      ['a non-string value', 42],
    ])('should reject %s with 400 exerciseVideo.invalidFileKey', (_label, key) => {
      let thrown;
      try {
        assertOwnVideoFileKey(TRAINER_ID, key);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        httpStatus: 400,
        error: ExerciseVideoErrorCode.INVALID_FILE_KEY,
        messageCode: ExerciseVideoMessageCode.INVALID_FILE_KEY,
        details: {},
      });
    });
  });

  describe('resolveExerciseVideoUrl', () => {
    it('should sign a key under the exercise-videos prefix', async () => {
      const s3 = { resolveUrl: vi.fn().mockResolvedValue('https://signed') };

      const url = await resolveExerciseVideoUrl(s3, OWN_KEY);

      expect(url).toBe('https://signed');
      expect(s3.resolveUrl).toHaveBeenCalledWith(OWN_KEY);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['a foreign prefix', 'avatars/user-1/a.png'],
      ['a non-string', 5],
    ])('should return null without signing for %s', async (_label, key) => {
      const s3 = { resolveUrl: vi.fn() };

      expect(await resolveExerciseVideoUrl(s3, key)).toBeNull();
      expect(s3.resolveUrl).not.toHaveBeenCalled();
    });
  });
});

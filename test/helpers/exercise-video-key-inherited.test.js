import { describe, it, expect } from 'vitest';
import { assertVideoFileKeyAllowed } from '../../src/helpers/exercise-video-key.js';
import { ExerciseVideoMessageCode } from '../../src/constants/exercise-video.js';

const TRAINER_ID = 'trainer-1';
const OTHER_TRAINER_ID = 'trainer-2';
const OWN_KEY = `exercise-videos/${TRAINER_ID}/own.mp4`;
const FOREIGN_KEY = `exercise-videos/${OTHER_TRAINER_ID}/foreign.mp4`;
const OTHER_FOREIGN_KEY = `exercise-videos/${OTHER_TRAINER_ID}/other.mp4`;
const TRAVERSAL_KEY = `exercise-videos/${OTHER_TRAINER_ID}/../${TRAINER_ID}/x.mp4`;
const OTHER_PREFIX_KEY = 'tutorials/abc.mp4';

// Asserts the call throws the invalid file key 400.
function expectInvalidKey(call) {
  expect(call).toThrow(expect.objectContaining({
    httpStatus: 400,
    messageCode: ExerciseVideoMessageCode.INVALID_FILE_KEY,
  }));
}

describe('assertVideoFileKeyAllowed', () => {
  describe('accepted keys', () => {
    it.each([['undefined', undefined], ['null', null]])('should pass %s', (_label, key) => {
      expect(() => assertVideoFileKeyAllowed(TRAINER_ID, key)).not.toThrow();
    });

    it('should pass an own-prefix key', () => {
      expect(() => assertVideoFileKeyAllowed(TRAINER_ID, OWN_KEY)).not.toThrow();
    });

    it('should pass a foreign key present in allowedKeys', () => {
      expect(() => assertVideoFileKeyAllowed(TRAINER_ID, FOREIGN_KEY, [FOREIGN_KEY])).not.toThrow();
    });

    it('should pass a foreign key when allowedKeys also holds null and undefined entries', () => {
      expect(() => assertVideoFileKeyAllowed(TRAINER_ID, FOREIGN_KEY, [undefined, null, FOREIGN_KEY])).not.toThrow();
    });
  });

  describe('rejected keys', () => {
    it('should throw 400 for a foreign key with no allowedKeys', () => {
      expectInvalidKey(() => assertVideoFileKeyAllowed(TRAINER_ID, FOREIGN_KEY));
    });

    it('should throw 400 for a foreign key absent from allowedKeys', () => {
      expectInvalidKey(() => assertVideoFileKeyAllowed(TRAINER_ID, FOREIGN_KEY, [OTHER_FOREIGN_KEY, undefined]));
    });

    it('should throw 400 for a key outside the exercise-videos prefix even when allowed', () => {
      expectInvalidKey(() => assertVideoFileKeyAllowed(TRAINER_ID, OTHER_PREFIX_KEY, [OTHER_PREFIX_KEY]));
    });

    it('should throw 400 for a traversal key even when allowed', () => {
      expectInvalidKey(() => assertVideoFileKeyAllowed(TRAINER_ID, TRAVERSAL_KEY, [TRAVERSAL_KEY]));
    });

    it('should throw 400 for a non-string key', () => {
      expectInvalidKey(() => assertVideoFileKeyAllowed(TRAINER_ID, 123, [123]));
    });
  });
});

export const ExerciseVideoErrorCode = Object.freeze({
  INVALID_FILE_KEY: 'EXERCISE_VIDEO_INVALID_FILE_KEY',
});

export const ExerciseVideoMessageCode = Object.freeze({
  INVALID_FILE_KEY: 'exerciseVideo.invalidFileKey',
});

export const EXERCISE_VIDEO_KEY_PREFIX = 'exercise-videos/';
export const EXERCISE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const EXERCISE_VIDEO_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60;
export const EXERCISE_VIDEO_UPLOAD_METHOD = 'PUT';
export const EXERCISE_VIDEO_KEY_MAX_LENGTH = 512;
export const EXERCISE_VIDEO_KEY_SHAPE_PATTERN = '^[A-Za-z0-9_-]+/[A-Za-z0-9._/-]+$';
export const VIDEO_FILE_URL_FIELD = 'videoFileUrl';
export const EXERCISE_VIDEO_KEY_FILENAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const EXERCISE_VIDEO_MIME_TO_EXTENSION = Object.freeze({
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
});

export const TutorialErrorCode = Object.freeze({
  NOT_FOUND: 'TUTORIAL_NOT_FOUND',
  INVALID_VIDEO_TYPE: 'TUTORIAL_INVALID_VIDEO_TYPE',
  VIDEO_TOO_LARGE: 'TUTORIAL_VIDEO_TOO_LARGE',
  INVALID_VIDEO_KEY: 'TUTORIAL_INVALID_VIDEO_KEY',
  INVALID_ORDER: 'TUTORIAL_INVALID_ORDER',
});

export const TutorialMessageCode = Object.freeze({
  NOT_FOUND: 'tutorial.notFound',
  INVALID_VIDEO_TYPE: 'tutorial.invalidVideoType',
  VIDEO_TOO_LARGE: 'tutorial.videoTooLarge',
  INVALID_VIDEO_KEY: 'tutorial.invalidVideoKey',
  INVALID_ORDER: 'tutorial.invalidOrder',
});

export const TutorialVideoSource = Object.freeze({
  LINK: 'link',
  UPLOAD: 'upload',
});

export const TUTORIAL_TITLE_MAX = 120;
export const TUTORIAL_DESCRIPTION_MAX = 2000;
export const TUTORIAL_MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const TUTORIAL_KEY_PREFIX = 'tutorials/';
export const TUTORIAL_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60;
export const TUTORIAL_PLAYBACK_URL_EXPIRES_SECONDS = 6 * 60 * 60;

export const TUTORIAL_MIME_TO_EXTENSION = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
});

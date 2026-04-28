export const VideoErrorCode = Object.freeze({
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  VIDEO_INVALID_URL: 'VIDEO_INVALID_URL',
  VIDEO_INVALID_CATEGORY: 'VIDEO_INVALID_CATEGORY',
  VIDEO_INVALID_BODY_SEGMENT: 'VIDEO_INVALID_BODY_SEGMENT',
  VIDEO_TITLE_REQUIRED: 'VIDEO_TITLE_REQUIRED',
  VIDEO_TAGS_EXCEEDED: 'VIDEO_TAGS_EXCEEDED',
});

export const VideoMessageCode = Object.freeze({
  NOT_FOUND: 'video.notFound',
  INVALID_URL: 'video.invalidUrl',
  INVALID_CATEGORY: 'video.invalidCategory',
  INVALID_BODY_SEGMENT: 'video.invalidBodySegment',
  TITLE_REQUIRED: 'video.titleRequired',
  TAGS_EXCEEDED: 'video.tagsExceeded',
});

export const VIDEO_TITLE_MAX = 200;
export const VIDEO_DESCRIPTION_MAX = 2000;
export const VIDEO_TAG_MAX = 50;
export const VIDEO_TAGS_MAX_COUNT = 20;
export const VIDEO_DURATION_MAX = 86_400;
export const VIDEO_LIST_PAGE_SIZE_DEFAULT = 20;
export const VIDEO_LIST_PAGE_SIZE_MAX = 100;

export const VIDEO_URL_REGEX = /^https?:\/\/[^\s]+$/i;

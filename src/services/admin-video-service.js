import { AppError } from '../errors/app-error.js';
import {
  VideoErrorCode,
  VideoMessageCode,
  VIDEO_TITLE_MAX,
  VIDEO_DESCRIPTION_MAX,
  VIDEO_TAG_MAX,
  VIDEO_TAGS_MAX_COUNT,
  VIDEO_DURATION_MAX,
  VIDEO_LIST_PAGE_SIZE_DEFAULT,
  VIDEO_LIST_PAGE_SIZE_MAX,
  VIDEO_URL_REGEX,
} from '../constants/video.js';
import { trainingCategoryValues, bodySegmentValues } from '../constants/training.js';

function videoError(errorCode, messageCode, message, httpStatus = 400) {
  return new AppError({ httpStatus, error: errorCode, messageCode, message });
}

function validateUrl(url) {
  if (typeof url !== 'string' || !VIDEO_URL_REGEX.test(url.trim())) {
    throw videoError(
      VideoErrorCode.VIDEO_INVALID_URL,
      VideoMessageCode.INVALID_URL,
      'Invalid video URL. Must start with http:// or https://.',
    );
  }
}

function validateOptionalUrl(url) {
  if (url == null) return;
  validateUrl(url);
}

function validateCategory(category) {
  if (!trainingCategoryValues.includes(category)) {
    throw videoError(
      VideoErrorCode.VIDEO_INVALID_CATEGORY,
      VideoMessageCode.INVALID_CATEGORY,
      `Invalid category. Allowed: ${trainingCategoryValues.join(', ')}.`,
    );
  }
}

function validateBodySegment(bodySegment) {
  if (bodySegment == null) return;
  if (!bodySegmentValues.includes(bodySegment)) {
    throw videoError(
      VideoErrorCode.VIDEO_INVALID_BODY_SEGMENT,
      VideoMessageCode.INVALID_BODY_SEGMENT,
      `Invalid body segment. Allowed: ${bodySegmentValues.join(', ')}.`,
    );
  }
}

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw videoError(
      VideoErrorCode.VIDEO_TITLE_REQUIRED,
      VideoMessageCode.TITLE_REQUIRED,
      'Title is required.',
    );
  }
  if (title.length > VIDEO_TITLE_MAX) {
    throw videoError(
      VideoErrorCode.VIDEO_TITLE_REQUIRED,
      VideoMessageCode.TITLE_REQUIRED,
      `Title exceeds ${VIDEO_TITLE_MAX} characters.`,
    );
  }
}

function validateDescription(description) {
  if (description == null) return;
  if (typeof description !== 'string' || description.length > VIDEO_DESCRIPTION_MAX) {
    throw videoError(
      VideoErrorCode.VIDEO_TITLE_REQUIRED,
      VideoMessageCode.TITLE_REQUIRED,
      `Description exceeds ${VIDEO_DESCRIPTION_MAX} characters.`,
    );
  }
}

function validateDuration(duration) {
  if (duration == null) return;
  if (!Number.isInteger(duration) || duration < 0 || duration > VIDEO_DURATION_MAX) {
    throw videoError(
      VideoErrorCode.VIDEO_INVALID_URL,
      VideoMessageCode.INVALID_URL,
      `Duration must be a non-negative integer up to ${VIDEO_DURATION_MAX} seconds.`,
    );
  }
}

function normalizeTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) {
    throw videoError(
      VideoErrorCode.VIDEO_TAGS_EXCEEDED,
      VideoMessageCode.TAGS_EXCEEDED,
      'Tags must be an array of strings.',
    );
  }
  const seen = new Set();
  const cleaned = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (!tag || tag.length > VIDEO_TAG_MAX) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    cleaned.push(tag);
  }
  if (cleaned.length > VIDEO_TAGS_MAX_COUNT) {
    throw videoError(
      VideoErrorCode.VIDEO_TAGS_EXCEEDED,
      VideoMessageCode.TAGS_EXCEEDED,
      `Maximum of ${VIDEO_TAGS_MAX_COUNT} tags exceeded.`,
    );
  }
  return cleaned;
}

function clampPageSize(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : VIDEO_LIST_PAGE_SIZE_DEFAULT;
  if (n < 1) return 1;
  if (n > VIDEO_LIST_PAGE_SIZE_MAX) return VIDEO_LIST_PAGE_SIZE_MAX;
  return n;
}

function clampPage(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : 1;
  return n < 1 ? 1 : n;
}

export async function createVideo(db, adminId, data) {
  validateTitle(data.title);
  validateDescription(data.description);
  validateUrl(data.url);
  validateOptionalUrl(data.thumbnailUrl);
  validateCategory(data.category);
  validateBodySegment(data.bodySegment);
  validateDuration(data.duration);
  const tags = normalizeTags(data.tags);

  return db.video.create({
    data: {
      title: data.title.trim(),
      description: data.description?.trim() ?? null,
      url: data.url.trim(),
      thumbnailUrl: data.thumbnailUrl?.trim() ?? null,
      duration: data.duration ?? null,
      category: data.category,
      bodySegment: data.bodySegment ?? null,
      tags,
      createdById: adminId,
    },
  });
}

export async function listVideos(db, filters = {}) {
  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where = { deletedAt: null };

  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
    ];
  }

  if (filters.category) {
    if (!trainingCategoryValues.includes(filters.category)) {
      throw videoError(
        VideoErrorCode.VIDEO_INVALID_CATEGORY,
        VideoMessageCode.INVALID_CATEGORY,
        `Invalid category filter.`,
      );
    }
    where.category = filters.category;
  }

  if (filters.bodySegment) {
    if (!bodySegmentValues.includes(filters.bodySegment)) {
      throw videoError(
        VideoErrorCode.VIDEO_INVALID_BODY_SEGMENT,
        VideoMessageCode.INVALID_BODY_SEGMENT,
        `Invalid body segment filter.`,
      );
    }
    where.bodySegment = filters.bodySegment;
  }

  if (filters.tag && typeof filters.tag === 'string' && filters.tag.trim()) {
    where.tags = { has: filters.tag.trim().toLowerCase() };
  }

  const [items, total] = await Promise.all([
    db.video.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.video.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getVideoById(db, videoId) {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video || video.deletedAt) {
    throw videoError(
      VideoErrorCode.VIDEO_NOT_FOUND,
      VideoMessageCode.NOT_FOUND,
      'Video not found.',
      404,
    );
  }
  return video;
}

export async function updateVideo(db, videoId, data) {
  await getVideoById(db, videoId);

  const updateData = {};

  if (data.title !== undefined) {
    validateTitle(data.title);
    updateData.title = data.title.trim();
  }
  if (data.description !== undefined) {
    validateDescription(data.description);
    updateData.description = data.description?.trim() ?? null;
  }
  if (data.url !== undefined) {
    validateUrl(data.url);
    updateData.url = data.url.trim();
  }
  if (data.thumbnailUrl !== undefined) {
    validateOptionalUrl(data.thumbnailUrl);
    updateData.thumbnailUrl = data.thumbnailUrl?.trim() ?? null;
  }
  if (data.duration !== undefined) {
    validateDuration(data.duration);
    updateData.duration = data.duration ?? null;
  }
  if (data.category !== undefined) {
    validateCategory(data.category);
    updateData.category = data.category;
  }
  if (data.bodySegment !== undefined) {
    validateBodySegment(data.bodySegment);
    updateData.bodySegment = data.bodySegment ?? null;
  }
  if (data.tags !== undefined) {
    updateData.tags = normalizeTags(data.tags);
  }

  return db.video.update({ where: { id: videoId }, data: updateData });
}

export async function deleteVideo(db, videoId) {
  await getVideoById(db, videoId);
  await db.video.update({
    where: { id: videoId },
    data: { deletedAt: new Date() },
  });
  return { id: videoId, deletedAt: new Date().toISOString() };
}

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createVideo,
  listVideos,
  getVideoById,
  updateVideo,
  deleteVideo,
} from '../../src/services/admin-video-service.js';
import { VideoErrorCode, VideoMessageCode } from '../../src/constants/video.js';

const ADMIN_ID = 'admin-1';
const VIDEO_ID = 'video-1';

const baseVideo = {
  id: VIDEO_ID,
  title: 'Push Up',
  description: 'Form guide',
  url: 'https://www.youtube.com/watch?v=abc',
  thumbnailUrl: null,
  duration: 60,
  category: 'strength',
  bodySegment: 'upper',
  tags: ['push', 'chest'],
  createdById: ADMIN_ID,
  createdAt: new Date(),
  updatedAt: null,
  deletedAt: null,
};

function makeDb() {
  return {
    video: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  };
}

let db;

beforeEach(() => {
  db = makeDb();
});

describe('admin-video-service.createVideo', () => {
  it('creates video with normalized payload', async () => {
    db.video.create.mockResolvedValue(baseVideo);

    const result = await createVideo(db, ADMIN_ID, {
      title: '  Push Up  ',
      description: ' Form guide ',
      url: 'https://www.youtube.com/watch?v=abc',
      category: 'strength',
      bodySegment: 'upper',
      duration: 60,
      tags: ['Push', 'push', '  CHEST  ', ''],
    });

    expect(result).toBe(baseVideo);
    expect(db.video.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Push Up',
        description: 'Form guide',
        url: 'https://www.youtube.com/watch?v=abc',
        category: 'strength',
        bodySegment: 'upper',
        duration: 60,
        tags: ['push', 'chest'],
        createdById: ADMIN_ID,
      }),
    });
  });

  it('rejects missing title', async () => {
    await expect(
      createVideo(db, ADMIN_ID, {
        title: '   ',
        url: 'https://x.com/a',
        category: 'strength',
      }),
    ).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_TITLE_REQUIRED,
      messageCode: VideoMessageCode.TITLE_REQUIRED,
    });
    expect(db.video.create).not.toHaveBeenCalled();
  });

  it('rejects invalid url', async () => {
    await expect(
      createVideo(db, ADMIN_ID, {
        title: 'X',
        url: 'ftp://nope',
        category: 'strength',
      }),
    ).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_INVALID_URL,
      messageCode: VideoMessageCode.INVALID_URL,
    });
  });

  it('rejects invalid category', async () => {
    await expect(
      createVideo(db, ADMIN_ID, {
        title: 'X',
        url: 'https://x.com/a',
        category: 'unknown',
      }),
    ).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_INVALID_CATEGORY,
      messageCode: VideoMessageCode.INVALID_CATEGORY,
    });
  });

  it('rejects invalid body segment when provided', async () => {
    await expect(
      createVideo(db, ADMIN_ID, {
        title: 'X',
        url: 'https://x.com/a',
        category: 'strength',
        bodySegment: 'sideways',
      }),
    ).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_INVALID_BODY_SEGMENT,
    });
  });

  it('allows null/missing body segment', async () => {
    db.video.create.mockResolvedValue(baseVideo);

    await createVideo(db, ADMIN_ID, {
      title: 'X',
      url: 'https://x.com/a',
      category: 'strength',
    });

    expect(db.video.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bodySegment: null }),
    });
  });

  it('rejects too many tags after normalization', async () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `tag${i}`);
    await expect(
      createVideo(db, ADMIN_ID, {
        title: 'X',
        url: 'https://x.com/a',
        category: 'strength',
        tags: tooMany,
      }),
    ).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_TAGS_EXCEEDED,
    });
  });

  it('rejects negative duration', async () => {
    await expect(
      createVideo(db, ADMIN_ID, {
        title: 'X',
        url: 'https://x.com/a',
        category: 'strength',
        duration: -1,
      }),
    ).rejects.toMatchObject({ messageCode: VideoMessageCode.INVALID_URL });
  });
});

describe('admin-video-service.listVideos', () => {
  it('paginates with defaults and excludes soft-deleted', async () => {
    db.video.findMany.mockResolvedValue([baseVideo]);
    db.video.count.mockResolvedValue(1);

    const result = await listVideos(db, {});

    expect(result).toEqual({ items: [baseVideo], total: 1, page: 1, pageSize: 20 });
    const args = db.video.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('clamps pageSize to max 100', async () => {
    db.video.findMany.mockResolvedValue([]);
    db.video.count.mockResolvedValue(0);

    const result = await listVideos(db, { pageSize: 5000 });

    expect(result.pageSize).toBe(100);
    expect(db.video.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('builds search OR filter on title and description', async () => {
    db.video.findMany.mockResolvedValue([]);
    db.video.count.mockResolvedValue(0);

    await listVideos(db, { search: 'squat' });

    expect(db.video.findMany.mock.calls[0][0].where.OR).toEqual([
      { title: { contains: 'squat', mode: 'insensitive' } },
      { description: { contains: 'squat', mode: 'insensitive' } },
    ]);
  });

  it('filters by tag (lowercase)', async () => {
    db.video.findMany.mockResolvedValue([]);
    db.video.count.mockResolvedValue(0);

    await listVideos(db, { tag: '  Chest ' });

    expect(db.video.findMany.mock.calls[0][0].where.tags).toEqual({ has: 'chest' });
  });

  it('rejects invalid category filter', async () => {
    await expect(listVideos(db, { category: 'invalid' })).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_INVALID_CATEGORY,
    });
  });
});

describe('admin-video-service.getVideoById', () => {
  it('returns the video', async () => {
    db.video.findUnique.mockResolvedValue(baseVideo);
    const result = await getVideoById(db, VIDEO_ID);
    expect(result).toBe(baseVideo);
  });

  it('throws 404 when missing', async () => {
    db.video.findUnique.mockResolvedValue(null);
    await expect(getVideoById(db, VIDEO_ID)).rejects.toMatchObject({
      httpStatus: 404,
      error: VideoErrorCode.VIDEO_NOT_FOUND,
    });
  });

  it('throws 404 when soft-deleted', async () => {
    db.video.findUnique.mockResolvedValue({ ...baseVideo, deletedAt: new Date() });
    await expect(getVideoById(db, VIDEO_ID)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe('admin-video-service.updateVideo', () => {
  it('applies partial updates', async () => {
    db.video.findUnique.mockResolvedValue(baseVideo);
    db.video.update.mockResolvedValue({ ...baseVideo, title: 'Squat' });

    await updateVideo(db, VIDEO_ID, { title: 'Squat', tags: ['LEGS', 'legs'] });

    expect(db.video.update).toHaveBeenCalledWith({
      where: { id: VIDEO_ID },
      data: { title: 'Squat', tags: ['legs'] },
    });
  });

  it('rejects invalid url on update', async () => {
    db.video.findUnique.mockResolvedValue(baseVideo);
    await expect(updateVideo(db, VIDEO_ID, { url: 'not-a-url' })).rejects.toMatchObject({
      error: VideoErrorCode.VIDEO_INVALID_URL,
    });
    expect(db.video.update).not.toHaveBeenCalled();
  });

  it('throws 404 when target missing', async () => {
    db.video.findUnique.mockResolvedValue(null);
    await expect(updateVideo(db, VIDEO_ID, { title: 'X' })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe('admin-video-service.deleteVideo', () => {
  it('soft deletes', async () => {
    db.video.findUnique.mockResolvedValue(baseVideo);
    db.video.update.mockResolvedValue(baseVideo);

    const result = await deleteVideo(db, VIDEO_ID);

    expect(db.video.update).toHaveBeenCalledWith({
      where: { id: VIDEO_ID },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result.id).toBe(VIDEO_ID);
  });

  it('throws 404 when missing', async () => {
    db.video.findUnique.mockResolvedValue(null);
    await expect(deleteVideo(db, VIDEO_ID)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createTutorial,
  listTutorials,
  getTutorialById,
  updateTutorial,
  deleteTutorial,
  reorderTutorials,
  createUploadUrl,
  listTutorialsForTrainer,
} from '../../src/services/tutorial-service.js';
import { NotFoundAppError, ValidationAppError } from '../../src/errors/app-error.js';

const ADMIN_ID = 'admin-1';
const TUTORIAL_ID = 'tutorial-1';
const LINK_URL = 'https://www.youtube.com/watch?v=abc';
const OLD_KEY = 'tutorials/old-video.mp4';
const NEW_KEY = 'tutorials/new-video.mp4';
const SIGNED_GET_URL = 'https://signed.example.com/get';
const SIGNED_PUT_URL = 'https://signed.example.com/put';
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

const MessageCode = {
  NOT_FOUND: 'tutorial.notFound',
  INVALID_VIDEO_TYPE: 'tutorial.invalidVideoType',
  VIDEO_TOO_LARGE: 'tutorial.videoTooLarge',
  INVALID_VIDEO_KEY: 'tutorial.invalidVideoKey',
  INVALID_ORDER: 'tutorial.invalidOrder',
};

// Builds a link tutorial row as stored in the database.
function makeRow(overrides = {}) {
  return {
    id: TUTORIAL_ID,
    title: 'Como criar um treino',
    description: 'Passo a passo',
    videoSource: 'LINK',
    videoUrl: LINK_URL,
    videoKey: null,
    order: 0,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

// Builds an upload tutorial row as stored in the database.
function makeUploadRow(overrides = {}) {
  return makeRow({
    videoSource: 'UPLOAD',
    videoUrl: null,
    videoKey: OLD_KEY,
    ...overrides,
  });
}

// Builds a Prisma-like mock exposing the tutorial model and transactions.
function makeDb() {
  const db = {
    tutorial: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return db;
}

// Builds a mock of the S3 handler methods the service depends on.
function makeS3() {
  return {
    getSignedPutUrl: vi.fn().mockResolvedValue(SIGNED_PUT_URL),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    resolveUrl: vi.fn().mockResolvedValue(SIGNED_GET_URL),
  };
}

let db;
let s3;

beforeEach(() => {
  db = makeDb();
  s3 = makeS3();
  db.tutorial.aggregate.mockResolvedValue({ _max: { order: null } });
  db.tutorial.create.mockImplementation(async ({ data }) => makeRow(data));
});

describe('tutorial-service.createTutorial', () => {
  describe('link source', () => {
    it('creates a link tutorial with trimmed title and description', async () => {
      await createTutorial(
        db,
        { title: '  Intro  ', description: '  Hello  ', videoSource: 'link', videoUrl: LINK_URL },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Intro',
          description: 'Hello',
          videoSource: 'LINK',
          videoUrl: LINK_URL,
          videoKey: null,
          createdById: ADMIN_ID,
        }),
      });
    });

    it('stores null description when it is omitted', async () => {
      await createTutorial(db, { title: 'Intro', videoSource: 'link', videoUrl: LINK_URL }, ADMIN_ID);

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ description: null }),
      });
    });

    it('returns the created record', async () => {
      const created = makeRow();
      db.tutorial.create.mockResolvedValue(created);

      const result = await createTutorial(
        db,
        { title: 'Intro', videoSource: 'link', videoUrl: LINK_URL },
        ADMIN_ID,
      );

      expect(result).toBe(created);
    });

    it('rejects a link tutorial without videoUrl', async () => {
      await expect(
        createTutorial(db, { title: 'Intro', videoSource: 'link' }, ADMIN_ID),
      ).rejects.toBeInstanceOf(ValidationAppError);
      expect(db.tutorial.create).not.toHaveBeenCalled();
    });

    it.each(['ftp://example.com/video.mp4', 'not-a-url', 'javascript:alert(1)', 'https://has space.com/a'])(
      'rejects non http(s) videoUrl %s',
      async (videoUrl) => {
        await expect(
          createTutorial(db, { title: 'Intro', videoSource: 'link', videoUrl }, ADMIN_ID),
        ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
        expect(db.tutorial.create).not.toHaveBeenCalled();
      },
    );

    it('accepts plain http videoUrl', async () => {
      await createTutorial(
        db,
        { title: 'Intro', videoSource: 'link', videoUrl: 'http://example.com/v.mp4' },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledTimes(1);
    });

    it('ignores a stray videoKey on a link tutorial', async () => {
      await createTutorial(
        db,
        { title: 'Intro', videoSource: 'link', videoUrl: LINK_URL, videoKey: NEW_KEY },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoKey: null }),
      });
    });
  });

  describe('upload source', () => {
    it('creates an upload tutorial storing the key and no url', async () => {
      await createTutorial(
        db,
        { title: 'Intro', videoSource: 'upload', videoKey: NEW_KEY },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          videoSource: 'UPLOAD',
          videoKey: NEW_KEY,
          videoUrl: null,
        }),
      });
    });

    it('rejects an upload tutorial without videoKey', async () => {
      await expect(
        createTutorial(db, { title: 'Intro', videoSource: 'upload' }, ADMIN_ID),
      ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.INVALID_VIDEO_KEY });
      expect(db.tutorial.create).not.toHaveBeenCalled();
    });

    it.each(['videos/other.mp4', 'branding/logo.png', '/tutorials/a.mp4', 'tutorial/a.mp4'])(
      'rejects videoKey %s outside the tutorials/ prefix',
      async (videoKey) => {
        await expect(
          createTutorial(db, { title: 'Intro', videoSource: 'upload', videoKey }, ADMIN_ID),
        ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.INVALID_VIDEO_KEY });
        expect(db.tutorial.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('common validation', () => {
    it.each([undefined, '', '   '])('rejects missing title %j', async (title) => {
      await expect(
        createTutorial(db, { title, videoSource: 'link', videoUrl: LINK_URL }, ADMIN_ID),
      ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
      expect(db.tutorial.create).not.toHaveBeenCalled();
    });

    it('accepts a title of exactly 120 characters', async () => {
      await createTutorial(
        db,
        { title: 'a'.repeat(TITLE_MAX), videoSource: 'link', videoUrl: LINK_URL },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a title longer than 120 characters', async () => {
      await expect(
        createTutorial(
          db,
          { title: 'a'.repeat(TITLE_MAX + 1), videoSource: 'link', videoUrl: LINK_URL },
          ADMIN_ID,
        ),
      ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
    });

    it('measures title length after trimming', async () => {
      await createTutorial(
        db,
        { title: `  ${'a'.repeat(TITLE_MAX)}  `, videoSource: 'link', videoUrl: LINK_URL },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledTimes(1);
    });

    it('accepts a description of exactly 2000 characters', async () => {
      await createTutorial(
        db,
        {
          title: 'Intro',
          description: 'd'.repeat(DESCRIPTION_MAX),
          videoSource: 'link',
          videoUrl: LINK_URL,
        },
        ADMIN_ID,
      );

      expect(db.tutorial.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a description longer than 2000 characters', async () => {
      await expect(
        createTutorial(
          db,
          {
            title: 'Intro',
            description: 'd'.repeat(DESCRIPTION_MAX + 1),
            videoSource: 'link',
            videoUrl: LINK_URL,
          },
          ADMIN_ID,
        ),
      ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
    });

    it.each([undefined, 'file', 'LINK'])('rejects invalid videoSource %j', async (videoSource) => {
      await expect(
        createTutorial(db, { title: 'Intro', videoSource, videoUrl: LINK_URL }, ADMIN_ID),
      ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
      expect(db.tutorial.create).not.toHaveBeenCalled();
    });
  });

  describe('ordering', () => {
    it('assigns order 0 when there are no tutorials', async () => {
      db.tutorial.aggregate.mockResolvedValue({ _max: { order: null } });

      await createTutorial(db, { title: 'First', videoSource: 'link', videoUrl: LINK_URL }, ADMIN_ID);

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 0 }),
      });
    });

    it('assigns max order plus one when tutorials exist', async () => {
      db.tutorial.aggregate.mockResolvedValue({ _max: { order: 4 } });

      await createTutorial(db, { title: 'Next', videoSource: 'link', videoUrl: LINK_URL }, ADMIN_ID);

      expect(db.tutorial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 5 }),
      });
    });
  });
});

describe('tutorial-service.listTutorials', () => {
  it('queries tutorials ordered by order ascending', async () => {
    db.tutorial.findMany.mockResolvedValue([]);

    await listTutorials(db, s3);

    expect(db.tutorial.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { order: 'asc' } }),
    );
  });

  it('returns an empty array when there are no tutorials', async () => {
    db.tutorial.findMany.mockResolvedValue([]);

    await expect(listTutorials(db, s3)).resolves.toEqual([]);
  });

  it('passes link urls through without resolving them', async () => {
    db.tutorial.findMany.mockResolvedValue([makeRow()]);

    const [item] = await listTutorials(db, s3);

    expect(item).toMatchObject({
      id: TUTORIAL_ID,
      videoSource: 'link',
      videoUrl: LINK_URL,
      videoKey: null,
    });
    expect(s3.resolveUrl).not.toHaveBeenCalled();
  });

  it('resolves upload keys to playable urls and keeps videoKey for admins', async () => {
    db.tutorial.findMany.mockResolvedValue([makeUploadRow()]);

    const [item] = await listTutorials(db, s3);

    expect(s3.resolveUrl).toHaveBeenCalledWith(OLD_KEY, expect.any(Number));
    expect(item).toMatchObject({
      videoSource: 'upload',
      videoUrl: SIGNED_GET_URL,
      videoKey: OLD_KEY,
    });
  });

  it('exposes the documented fields with lowercase videoSource', async () => {
    db.tutorial.findMany.mockResolvedValue([makeRow({ order: 3 })]);

    const [item] = await listTutorials(db, s3);

    expect(Object.keys(item).sort()).toEqual(
      ['createdAt', 'description', 'id', 'order', 'title', 'updatedAt', 'videoKey', 'videoSource', 'videoUrl'],
    );
    expect(item.order).toBe(3);
  });

  it('preserves the order returned by the database', async () => {
    db.tutorial.findMany.mockResolvedValue([
      makeRow({ id: 'a', order: 0 }),
      makeUploadRow({ id: 'b', order: 1 }),
      makeRow({ id: 'c', order: 2 }),
    ]);

    const items = await listTutorials(db, s3);

    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('tutorial-service.listTutorialsForTrainer', () => {
  it('queries tutorials ordered by order ascending', async () => {
    db.tutorial.findMany.mockResolvedValue([]);

    await listTutorialsForTrainer(db, s3);

    expect(db.tutorial.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { order: 'asc' } }),
    );
  });

  it('omits videoKey from every item', async () => {
    db.tutorial.findMany.mockResolvedValue([makeRow(), makeUploadRow({ id: 'b', order: 1 })]);

    const items = await listTutorialsForTrainer(db, s3);

    items.forEach((item) => expect(item).not.toHaveProperty('videoKey'));
  });

  it('resolves upload keys and passes links as-is', async () => {
    db.tutorial.findMany.mockResolvedValue([makeRow(), makeUploadRow({ id: 'b', order: 1 })]);

    const [link, upload] = await listTutorialsForTrainer(db, s3);

    expect(link.videoUrl).toBe(LINK_URL);
    expect(upload.videoUrl).toBe(SIGNED_GET_URL);
    expect(s3.resolveUrl).toHaveBeenCalledTimes(1);
  });
});

describe('tutorial-service.getTutorialById', () => {
  it('returns the formatted tutorial', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());

    const result = await getTutorialById(db, s3, TUTORIAL_ID);

    expect(db.tutorial.findUnique).toHaveBeenCalledWith({ where: { id: TUTORIAL_ID } });
    expect(result).toMatchObject({
      id: TUTORIAL_ID,
      videoSource: 'upload',
      videoUrl: SIGNED_GET_URL,
      videoKey: OLD_KEY,
    });
  });

  it('throws NotFoundAppError with tutorial.notFound when missing', async () => {
    db.tutorial.findUnique.mockResolvedValue(null);

    const promise = getTutorialById(db, s3, 'missing');

    await expect(promise).rejects.toBeInstanceOf(NotFoundAppError);
    await expect(promise).rejects.toMatchObject({
      httpStatus: 404,
      messageCode: MessageCode.NOT_FOUND,
    });
  });
});

describe('tutorial-service.updateTutorial', () => {
  it('throws NotFoundAppError with tutorial.notFound when missing', async () => {
    db.tutorial.findUnique.mockResolvedValue(null);

    const promise = updateTutorial(db, s3, 'missing', { title: 'X' });

    await expect(promise).rejects.toBeInstanceOf(NotFoundAppError);
    await expect(promise).rejects.toMatchObject({ messageCode: MessageCode.NOT_FOUND });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('updates only the title and trims it', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());
    db.tutorial.update.mockResolvedValue(makeRow({ title: 'New' }));

    const result = await updateTutorial(db, s3, TUTORIAL_ID, { title: '  New  ' });

    expect(db.tutorial.update).toHaveBeenCalledWith({
      where: { id: TUTORIAL_ID },
      data: expect.objectContaining({ title: 'New' }),
    });
    expect(result.title).toBe('New');
  });

  it('does not touch the video fields when the patch has none', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());
    db.tutorial.update.mockResolvedValue(makeRow());

    await updateTutorial(db, s3, TUTORIAL_ID, { title: 'New' });

    const { data } = db.tutorial.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('videoSource');
    expect(data).not.toHaveProperty('videoUrl');
    expect(data).not.toHaveProperty('videoKey');
  });

  it('does not delete any file when the video is unchanged', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
    db.tutorial.update.mockResolvedValue(makeUploadRow({ title: 'New' }));

    await updateTutorial(db, s3, TUTORIAL_ID, { title: 'New' });

    expect(s3.deleteFile).not.toHaveBeenCalled();
  });

  it('allows clearing the description with null', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());
    db.tutorial.update.mockResolvedValue(makeRow({ description: null }));

    await updateTutorial(db, s3, TUTORIAL_ID, { description: null });

    expect(db.tutorial.update).toHaveBeenCalledWith({
      where: { id: TUTORIAL_ID },
      data: expect.objectContaining({ description: null }),
    });
  });

  it('rejects an empty title', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());

    await expect(updateTutorial(db, s3, TUTORIAL_ID, { title: '  ' })).rejects.toMatchObject({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
    });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('rejects a title longer than 120 characters', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { title: 'a'.repeat(TITLE_MAX + 1) }),
    ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
  });

  it('rejects a description longer than 2000 characters', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { description: 'd'.repeat(DESCRIPTION_MAX + 1) }),
    ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
  });

  it('rejects a new link url that is not http(s)', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link', videoUrl: 'ftp://x.com/v' }),
    ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('rejects a new videoKey outside the tutorials/ prefix', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: 'videos/x.mp4' }),
    ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.INVALID_VIDEO_KEY });
    expect(s3.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects switching to upload without a videoKey', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload' }),
    ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.INVALID_VIDEO_KEY });
  });

  it('rejects switching to link without a videoUrl', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());

    await expect(
      updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link' }),
    ).rejects.toMatchObject({ httpStatus: 400, error: 'VALIDATION_ERROR' });
    expect(s3.deleteFile).not.toHaveBeenCalled();
  });

  describe('switching upload to link', () => {
    beforeEach(() => {
      db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
      db.tutorial.update.mockResolvedValue(makeRow());
    });

    it('clears videoKey and stores the link', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link', videoUrl: LINK_URL });

      expect(db.tutorial.update).toHaveBeenCalledWith({
        where: { id: TUTORIAL_ID },
        data: expect.objectContaining({
          videoSource: 'LINK',
          videoUrl: LINK_URL,
          videoKey: null,
        }),
      });
    });

    it('deletes the previously uploaded file', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link', videoUrl: LINK_URL });

      expect(s3.deleteFile).toHaveBeenCalledWith({ key: OLD_KEY });
    });

    it('still succeeds when deleting the old file fails', async () => {
      s3.deleteFile.mockRejectedValue(new Error('s3 down'));

      const result = await updateTutorial(db, s3, TUTORIAL_ID, {
        videoSource: 'link',
        videoUrl: LINK_URL,
      });

      expect(result).toMatchObject({ videoSource: 'link', videoUrl: LINK_URL });
    });

    it('does not delete the old file when the database update fails', async () => {
      db.tutorial.update.mockRejectedValue(new Error('db down'));

      await expect(
        updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link', videoUrl: LINK_URL }),
      ).rejects.toThrow('db down');
      expect(s3.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('replacing the uploaded file', () => {
    beforeEach(() => {
      db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
      db.tutorial.update.mockResolvedValue(makeUploadRow({ videoKey: NEW_KEY }));
    });

    it('stores the new key', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: NEW_KEY });

      expect(db.tutorial.update).toHaveBeenCalledWith({
        where: { id: TUTORIAL_ID },
        data: expect.objectContaining({
          videoSource: 'UPLOAD',
          videoKey: NEW_KEY,
          videoUrl: null,
        }),
      });
    });

    it('deletes the old key but not the new one', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: NEW_KEY });

      expect(s3.deleteFile).toHaveBeenCalledTimes(1);
      expect(s3.deleteFile).toHaveBeenCalledWith({ key: OLD_KEY });
    });

    it('does not delete anything when the same key is sent again', async () => {
      db.tutorial.update.mockResolvedValue(makeUploadRow());

      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: OLD_KEY });

      expect(s3.deleteFile).not.toHaveBeenCalled();
    });

    it('still succeeds when deleting the old file fails', async () => {
      s3.deleteFile.mockRejectedValue(new Error('s3 down'));

      const result = await updateTutorial(db, s3, TUTORIAL_ID, {
        videoSource: 'upload',
        videoKey: NEW_KEY,
      });

      expect(result.videoKey).toBe(NEW_KEY);
    });
  });

  describe('switching link to upload', () => {
    beforeEach(() => {
      db.tutorial.findUnique.mockResolvedValue(makeRow());
      db.tutorial.update.mockResolvedValue(makeUploadRow({ videoKey: NEW_KEY }));
    });

    it('stores the key and clears videoUrl', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: NEW_KEY });

      expect(db.tutorial.update).toHaveBeenCalledWith({
        where: { id: TUTORIAL_ID },
        data: expect.objectContaining({
          videoSource: 'UPLOAD',
          videoKey: NEW_KEY,
          videoUrl: null,
        }),
      });
    });

    it('has no previous file to delete', async () => {
      await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'upload', videoKey: NEW_KEY });

      expect(s3.deleteFile).not.toHaveBeenCalled();
    });

    it('returns the playable url resolved from the new key', async () => {
      const result = await updateTutorial(db, s3, TUTORIAL_ID, {
        videoSource: 'upload',
        videoKey: NEW_KEY,
      });

      expect(result.videoUrl).toBe(SIGNED_GET_URL);
    });
  });

  it('does not delete anything when replacing one link with another', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());
    db.tutorial.update.mockResolvedValue(makeRow({ videoUrl: 'https://vimeo.com/1' }));

    await updateTutorial(db, s3, TUTORIAL_ID, { videoSource: 'link', videoUrl: 'https://vimeo.com/1' });

    expect(s3.deleteFile).not.toHaveBeenCalled();
  });
});

describe('tutorial-service.deleteTutorial', () => {
  it('throws NotFoundAppError with tutorial.notFound when missing', async () => {
    db.tutorial.findUnique.mockResolvedValue(null);

    const promise = deleteTutorial(db, s3, 'missing');

    await expect(promise).rejects.toBeInstanceOf(NotFoundAppError);
    await expect(promise).rejects.toMatchObject({ messageCode: MessageCode.NOT_FOUND });
    expect(db.tutorial.delete).not.toHaveBeenCalled();
  });

  it('removes a link tutorial without touching S3', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeRow());
    db.tutorial.delete.mockResolvedValue(makeRow());

    await deleteTutorial(db, s3, TUTORIAL_ID);

    expect(db.tutorial.delete).toHaveBeenCalledWith({ where: { id: TUTORIAL_ID } });
    expect(s3.deleteFile).not.toHaveBeenCalled();
  });

  it('removes an upload tutorial and deletes its file', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
    db.tutorial.delete.mockResolvedValue(makeUploadRow());

    await deleteTutorial(db, s3, TUTORIAL_ID);

    expect(db.tutorial.delete).toHaveBeenCalledWith({ where: { id: TUTORIAL_ID } });
    expect(s3.deleteFile).toHaveBeenCalledWith({ key: OLD_KEY });
  });

  it('still succeeds when deleting the file fails', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
    db.tutorial.delete.mockResolvedValue(makeUploadRow());
    s3.deleteFile.mockRejectedValue(new Error('s3 down'));

    await expect(deleteTutorial(db, s3, TUTORIAL_ID)).resolves.not.toThrow();
  });

  it('keeps the file when the database delete fails', async () => {
    db.tutorial.findUnique.mockResolvedValue(makeUploadRow());
    db.tutorial.delete.mockRejectedValue(new Error('db down'));

    await expect(deleteTutorial(db, s3, TUTORIAL_ID)).rejects.toThrow('db down');
    expect(s3.deleteFile).not.toHaveBeenCalled();
  });
});

describe('tutorial-service.reorderTutorials', () => {
  const existing = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  beforeEach(() => {
    db.tutorial.findMany.mockResolvedValue(existing);
    db.tutorial.update.mockResolvedValue({});
  });

  it('persists the index of each id as its order', async () => {
    await reorderTutorials(db, ['c', 'a', 'b']);

    expect(db.tutorial.update).toHaveBeenCalledTimes(3);
    expect(db.tutorial.update).toHaveBeenCalledWith({ where: { id: 'c' }, data: { order: 0 } });
    expect(db.tutorial.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { order: 1 } });
    expect(db.tutorial.update).toHaveBeenCalledWith({ where: { id: 'b' }, data: { order: 2 } });
  });

  it('applies the updates inside a single transaction', async () => {
    await reorderTutorials(db, ['c', 'a', 'b']);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns the tutorials re-read in order ascending', async () => {
    const reordered = [makeRow({ id: 'c', order: 0 }), makeRow({ id: 'a', order: 1 }), makeRow({ id: 'b', order: 2 })];
    db.tutorial.findMany
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(reordered);

    const result = await reorderTutorials(db, ['c', 'a', 'b']);

    expect(result.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('rejects when an id is missing from the request', async () => {
    await expect(reorderTutorials(db, ['a', 'b'])).rejects.toMatchObject({
      httpStatus: 400,
      messageCode: MessageCode.INVALID_ORDER,
    });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('rejects when an unknown id is included', async () => {
    await expect(reorderTutorials(db, ['a', 'b', 'zzz'])).rejects.toMatchObject({
      httpStatus: 400,
      messageCode: MessageCode.INVALID_ORDER,
    });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids even when the length matches', async () => {
    await expect(reorderTutorials(db, ['a', 'a', 'b'])).rejects.toMatchObject({
      httpStatus: 400,
      messageCode: MessageCode.INVALID_ORDER,
    });
    expect(db.tutorial.update).not.toHaveBeenCalled();
  });

  it('rejects an empty list when tutorials exist', async () => {
    await expect(reorderTutorials(db, [])).rejects.toMatchObject({
      messageCode: MessageCode.INVALID_ORDER,
    });
  });
});

describe('tutorial-service.createUploadUrl', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/quicktime', 'mov'],
  ])('signs a PUT url for %s with a .%s key', async (contentType, extension) => {
    const result = await createUploadUrl(s3, { contentType, fileSize: 1024 });

    expect(result.videoKey).toMatch(
      new RegExp(`^tutorials/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${extension}$`),
    );
    expect(s3.getSignedPutUrl).toHaveBeenCalledWith({
      key: result.videoKey,
      contentType,
      expiresIn: result.expiresIn,
    });
  });

  it('returns uploadUrl, videoKey and a positive numeric expiresIn', async () => {
    const result = await createUploadUrl(s3, { contentType: 'video/mp4', fileSize: 1024 });

    expect(result).toEqual({
      uploadUrl: SIGNED_PUT_URL,
      videoKey: expect.stringMatching(/^tutorials\//),
      expiresIn: expect.any(Number),
    });
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  it('generates a different key on every call', async () => {
    const first = await createUploadUrl(s3, { contentType: 'video/mp4', fileSize: 1024 });
    const second = await createUploadUrl(s3, { contentType: 'video/mp4', fileSize: 1024 });

    expect(first.videoKey).not.toBe(second.videoKey);
  });

  it('accepts a file of exactly 500MB', async () => {
    await expect(
      createUploadUrl(s3, { contentType: 'video/mp4', fileSize: MAX_VIDEO_BYTES }),
    ).resolves.toHaveProperty('uploadUrl');
  });

  it('rejects a file larger than 500MB with tutorial.videoTooLarge', async () => {
    await expect(
      createUploadUrl(s3, { contentType: 'video/mp4', fileSize: MAX_VIDEO_BYTES + 1 }),
    ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.VIDEO_TOO_LARGE });
    expect(s3.getSignedPutUrl).not.toHaveBeenCalled();
  });

  it.each(['video/x-msvideo', 'image/png', 'application/pdf', 'video/MP4', '', undefined])(
    'rejects content type %j with tutorial.invalidVideoType',
    async (contentType) => {
      await expect(
        createUploadUrl(s3, { contentType, fileSize: 1024 }),
      ).rejects.toMatchObject({ httpStatus: 400, messageCode: MessageCode.INVALID_VIDEO_TYPE });
      expect(s3.getSignedPutUrl).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, undefined])('rejects invalid fileSize %j', async (fileSize) => {
    await expect(
      createUploadUrl(s3, { contentType: 'video/mp4', fileSize }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(s3.getSignedPutUrl).not.toHaveBeenCalled();
  });

  it('checks the content type before the size', async () => {
    await expect(
      createUploadUrl(s3, { contentType: 'image/png', fileSize: MAX_VIDEO_BYTES + 1 }),
    ).rejects.toMatchObject({ messageCode: MessageCode.INVALID_VIDEO_TYPE });
  });
});

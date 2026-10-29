import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DISABLED_S3_URL = 'https://example.com/disabled-s3-upload';
const LINK_URL = 'https://www.youtube.com/watch?v=IODxDxX7oi4';
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const STUDENT_PASSWORD = 'StrongPassw0rd!';

const ErrorMessageCode = {
  NOT_FOUND: 'tutorial.notFound',
  INVALID_VIDEO_TYPE: 'tutorial.invalidVideoType',
  VIDEO_TOO_LARGE: 'tutorial.videoTooLarge',
  INVALID_VIDEO_KEY: 'tutorial.invalidVideoKey',
  INVALID_ORDER: 'tutorial.invalidOrder',
};

e2eDescribe('e2e: tutorials', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createAdminWithToken() {
    const email = `e2e+admin-${Date.now()}-${Math.random()}@example.com`;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: STUDENT_PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const userId = signup.json().user.id;
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { roles: [Roles.ADMIN] },
    });
    const accessToken = app.jwt.sign({
      sub: updatedUser.id,
      email: updatedUser.email,
      roles: [Roles.ADMIN],
      status: updatedUser.status,
    });
    return { userId, accessToken };
  }

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}-${Math.random()}@example.com`;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: STUDENT_PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();
    const become = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(become.statusCode).toBe(200);
    return { userId, accessToken: become.json().token.accessToken };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-${Date.now()}-${Math.random()}@example.com`;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: STUDENT_PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();
    return { userId, accessToken };
  }

  function auth(accessToken) {
    return { authorization: `Bearer ${accessToken}` };
  }

  function linkPayload(overrides = {}) {
    return {
      title: 'Como criar um treino',
      description: 'Passo a passo completo',
      videoSource: 'link',
      videoUrl: LINK_URL,
      ...overrides,
    };
  }

  async function createTutorial(accessToken, payload = linkPayload()) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/tutorials',
      headers: auth(accessToken),
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toEqual(
      expect.objectContaining({
        error,
        messageCode,
        message: expect.any(String),
      }),
    );
    expect(body).toHaveProperty('details');
  }

  describe('POST /admin/tutorials/upload-url', () => {
    it.each(['video/mp4', 'video/webm', 'video/quicktime'])(
      'admin gets a presigned upload url for %s',
      async (contentType) => {
        const { accessToken } = await createAdminWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/admin/tutorials/upload-url',
          headers: auth(accessToken),
          payload: { contentType, fileSize: 10 * 1024 * 1024 },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          uploadUrl: DISABLED_S3_URL,
          videoKey: expect.stringMatching(/^tutorials\/.+\.(mp4|webm|mov)$/),
          expiresIn: expect.any(Number),
        });
      },
    );

    it('accepts a file of exactly 500MB', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/mp4', fileSize: MAX_VIDEO_BYTES },
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 400 tutorial.invalidVideoType for an unsupported content type', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/x-msvideo', fileSize: 1024 },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: expect.any(String),
        messageCode: ErrorMessageCode.INVALID_VIDEO_TYPE,
      });
    });

    it('returns 400 tutorial.videoTooLarge when the file exceeds 500MB', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/mp4', fileSize: MAX_VIDEO_BYTES + 1 },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: expect.any(String),
        messageCode: ErrorMessageCode.VIDEO_TOO_LARGE,
      });
    });

    it('returns 400 when fileSize is missing', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/mp4' },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/mp4', fileSize: 1024 },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        payload: { contentType: 'video/mp4', fileSize: 1024 },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /admin/tutorials', () => {
    it('admin creates a link tutorial', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        headers: auth(accessToken),
        payload: linkPayload(),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: expect.any(String),
        title: 'Como criar um treino',
        description: 'Passo a passo completo',
        videoSource: 'link',
        videoUrl: LINK_URL,
        videoKey: null,
        order: 0,
        createdAt: expect.any(String),
        updatedAt: expect.anything(),
      });
    });

    it('returns null description when omitted', async () => {
      const { accessToken } = await createAdminWithToken();
      const payload = linkPayload();
      delete payload.description;

      const body = await createTutorial(accessToken, payload);

      expect(body.description).toBeNull();
    });

    it('trims the title', async () => {
      const { accessToken } = await createAdminWithToken();

      const body = await createTutorial(accessToken, linkPayload({ title: '  Intro  ' }));

      expect(body.title).toBe('Intro');
    });

    it('admin creates an upload tutorial and gets a playable videoUrl', async () => {
      const { accessToken } = await createAdminWithToken();
      const uploadUrlResponse = await app.inject({
        method: 'POST',
        url: '/admin/tutorials/upload-url',
        headers: auth(accessToken),
        payload: { contentType: 'video/mp4', fileSize: 1024 },
      });
      const { videoKey } = uploadUrlResponse.json();

      const body = await createTutorial(accessToken, {
        title: 'Upload',
        videoSource: 'upload',
        videoKey,
      });

      expect(body).toMatchObject({
        videoSource: 'upload',
        videoKey,
        videoUrl: expect.stringMatching(/^https?:\/\//),
      });
    });

    it('assigns increasing order values', async () => {
      const { accessToken } = await createAdminWithToken();

      const first = await createTutorial(accessToken, linkPayload({ title: 'First' }));
      const second = await createTutorial(accessToken, linkPayload({ title: 'Second' }));
      const third = await createTutorial(accessToken, linkPayload({ title: 'Third' }));

      expect([first.order, second.order, third.order]).toEqual([0, 1, 2]);
    });

    it.each([
      ['missing title', { title: undefined }],
      ['blank title', { title: '   ' }],
      ['title over 120 chars', { title: 'a'.repeat(121) }],
      ['description over 2000 chars', { description: 'd'.repeat(2001) }],
      ['unknown videoSource', { videoSource: 'file' }],
      ['link without videoUrl', { videoUrl: undefined }],
      ['non http(s) videoUrl', { videoUrl: 'ftp://example.com/v.mp4' }],
      ['garbage videoUrl', { videoUrl: 'not-a-url' }],
    ])('returns 400 for %s', async (_label, overrides) => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        headers: auth(accessToken),
        payload: linkPayload(overrides),
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: 'VALIDATION_ERROR',
        messageCode: expect.any(String),
      });
    });

    it('returns 400 for an upload tutorial without videoKey', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        headers: auth(accessToken),
        payload: { title: 'Upload', videoSource: 'upload' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 tutorial.invalidVideoKey for a key outside tutorials/', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        headers: auth(accessToken),
        payload: { title: 'Upload', videoSource: 'upload', videoKey: 'videos/other.mp4' },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: expect.any(String),
        messageCode: ErrorMessageCode.INVALID_VIDEO_KEY,
      });
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        headers: auth(accessToken),
        payload: linkPayload(),
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/tutorials',
        payload: linkPayload(),
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /admin/tutorials', () => {
    it('returns an empty items array when there are no tutorials', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/admin/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    });

    it('lists tutorials sorted by order ascending including videoKey', async () => {
      const { accessToken } = await createAdminWithToken();
      await createTutorial(accessToken, linkPayload({ title: 'First' }));
      await createTutorial(accessToken, linkPayload({ title: 'Second' }));

      const response = await app.inject({
        method: 'GET',
        url: '/admin/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(200);
      const { items } = response.json();
      expect(items.map((t) => t.title)).toEqual(['First', 'Second']);
      items.forEach((item) => expect(item).toHaveProperty('videoKey'));
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/admin/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/tutorials' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /admin/tutorials/:id', () => {
    it('returns the tutorial', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);

      const response = await app.inject({
        method: 'GET',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: created.id, title: created.title, videoKey: null });
    });

    it('returns 404 tutorial.notFound for an unknown id', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(404);
      expectErrorContract(response.json(), {
        error: 'NOT_FOUND',
        messageCode: ErrorMessageCode.NOT_FOUND,
      });
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /admin/tutorials/:id', () => {
    it('updates title and description', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
        payload: { title: 'Novo título', description: 'Nova descrição' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: created.id,
        title: 'Novo título',
        description: 'Nova descrição',
        videoUrl: LINK_URL,
        order: created.order,
      });
    });

    it('switches a link tutorial to an uploaded video', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);
      const { videoKey } = (
        await app.inject({
          method: 'POST',
          url: '/admin/tutorials/upload-url',
          headers: auth(accessToken),
          payload: { contentType: 'video/webm', fileSize: 2048 },
        })
      ).json();

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
        payload: { videoSource: 'upload', videoKey },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ videoSource: 'upload', videoKey });
    });

    it('switches an uploaded tutorial back to a link and clears videoKey', async () => {
      const { accessToken } = await createAdminWithToken();
      const { videoKey } = (
        await app.inject({
          method: 'POST',
          url: '/admin/tutorials/upload-url',
          headers: auth(accessToken),
          payload: { contentType: 'video/mp4', fileSize: 2048 },
        })
      ).json();
      const created = await createTutorial(accessToken, {
        title: 'Upload',
        videoSource: 'upload',
        videoKey,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
        payload: { videoSource: 'link', videoUrl: LINK_URL },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        videoSource: 'link',
        videoUrl: LINK_URL,
        videoKey: null,
      });
    });

    it('returns 400 for an invalid videoUrl', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
        payload: { videoSource: 'link', videoUrl: 'not-a-url' },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: 'VALIDATION_ERROR',
        messageCode: expect.any(String),
      });
    });

    it('returns 400 for an empty title', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
        payload: { title: '   ' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 404 tutorial.notFound for an unknown id', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
        payload: { title: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expectErrorContract(response.json(), {
        error: 'NOT_FOUND',
        messageCode: ErrorMessageCode.NOT_FOUND,
      });
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
        payload: { title: 'X' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /admin/tutorials/:id', () => {
    it('deletes the tutorial and removes it from the list', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);

      const response = await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
      });
      const list = await app.inject({
        method: 'GET',
        url: '/admin/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(204);
      expect(list.json().items).toEqual([]);
    });

    it('deletes an uploaded tutorial', async () => {
      const { accessToken } = await createAdminWithToken();
      const { videoKey } = (
        await app.inject({
          method: 'POST',
          url: '/admin/tutorials/upload-url',
          headers: auth(accessToken),
          payload: { contentType: 'video/mp4', fileSize: 2048 },
        })
      ).json();
      const created = await createTutorial(accessToken, {
        title: 'Upload',
        videoSource: 'upload',
        videoKey,
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(204);
    });

    it('returns 404 tutorial.notFound for an unknown id', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(404);
      expectErrorContract(response.json(), {
        error: 'NOT_FOUND',
        messageCode: ErrorMessageCode.NOT_FOUND,
      });
    });

    it('returns 404 when deleting the same tutorial twice', async () => {
      const { accessToken } = await createAdminWithToken();
      const created = await createTutorial(accessToken);
      await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${created.id}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().messageCode).toBe(ErrorMessageCode.NOT_FOUND);
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'DELETE',
        url: `/admin/tutorials/${MISSING_ID}`,
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /admin/tutorials/reorder', () => {
    it('persists the new order and returns items in that order', async () => {
      const { accessToken } = await createAdminWithToken();
      const a = await createTutorial(accessToken, linkPayload({ title: 'A' }));
      const b = await createTutorial(accessToken, linkPayload({ title: 'B' }));
      const c = await createTutorial(accessToken, linkPayload({ title: 'C' }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [c.id, a.id, b.id] },
      });

      expect(response.statusCode).toBe(200);
      const { items } = response.json();
      expect(items.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
      expect(items.map((t) => t.order)).toEqual([0, 1, 2]);
    });

    it('is reflected by GET /admin/tutorials', async () => {
      const { accessToken } = await createAdminWithToken();
      const a = await createTutorial(accessToken, linkPayload({ title: 'A' }));
      const b = await createTutorial(accessToken, linkPayload({ title: 'B' }));
      await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [b.id, a.id] },
      });

      const list = await app.inject({
        method: 'GET',
        url: '/admin/tutorials',
        headers: auth(accessToken),
      });

      expect(list.json().items.map((t) => t.id)).toEqual([b.id, a.id]);
    });

    it('returns 400 tutorial.invalidOrder when an id is missing', async () => {
      const { accessToken } = await createAdminWithToken();
      const a = await createTutorial(accessToken, linkPayload({ title: 'A' }));
      await createTutorial(accessToken, linkPayload({ title: 'B' }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [a.id] },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: expect.any(String),
        messageCode: ErrorMessageCode.INVALID_ORDER,
      });
    });

    it('returns 400 tutorial.invalidOrder when an unknown id is included', async () => {
      const { accessToken } = await createAdminWithToken();
      const a = await createTutorial(accessToken, linkPayload({ title: 'A' }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [a.id, MISSING_ID] },
      });

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), {
        error: expect.any(String),
        messageCode: ErrorMessageCode.INVALID_ORDER,
      });
    });

    it('returns 400 when orderedIds is not an array', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: 'abc' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('is not shadowed by the :id route (does not 404 with tutorial.notFound)', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    });

    it('returns 403 to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(accessToken),
        payload: { orderedIds: [] },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        payload: { orderedIds: [] },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /tutorials', () => {
    it('trainer lists tutorials sorted by order without videoKey', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const first = await createTutorial(adminToken, linkPayload({ title: 'First' }));
      const second = await createTutorial(adminToken, linkPayload({ title: 'Second' }));
      await app.inject({
        method: 'PATCH',
        url: '/admin/tutorials/reorder',
        headers: auth(adminToken),
        payload: { orderedIds: [second.id, first.id] },
      });
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/tutorials',
        headers: auth(trainerToken),
      });

      expect(response.statusCode).toBe(200);
      const { items } = response.json();
      expect(items.map((t) => t.title)).toEqual(['Second', 'First']);
      items.forEach((item) => {
        expect(item).not.toHaveProperty('videoKey');
        expect(item).toMatchObject({
          id: expect.any(String),
          videoSource: 'link',
          videoUrl: LINK_URL,
          order: expect.any(Number),
          createdAt: expect.any(String),
        });
      });
    });

    it('resolves uploaded videos to a playable url', async () => {
      const { accessToken: adminToken } = await createAdminWithToken();
      const { videoKey } = (
        await app.inject({
          method: 'POST',
          url: '/admin/tutorials/upload-url',
          headers: auth(adminToken),
          payload: { contentType: 'video/mp4', fileSize: 2048 },
        })
      ).json();
      await createTutorial(adminToken, { title: 'Upload', videoSource: 'upload', videoKey });
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/tutorials',
        headers: auth(trainerToken),
      });

      const [item] = response.json().items;
      expect(item.videoSource).toBe('upload');
      expect(item.videoUrl).toMatch(/^https?:\/\//);
      expect(item).not.toHaveProperty('videoKey');
    });

    it('returns an empty items array when there are no tutorials', async () => {
      const { accessToken } = await createTrainerWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    });

    it('allows an admin', async () => {
      const { accessToken } = await createAdminWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 403 to a student', async () => {
      const { accessToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/tutorials',
        headers: auth(accessToken),
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/tutorials' });

      expect(response.statusCode).toBe(401);
    });
  });
});

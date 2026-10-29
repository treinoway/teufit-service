import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const KEY_A = 'tutorials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
const KEY_B = 'tutorials/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';

e2eDescribe('e2e: tutorial videoKey reuse and admin 403 contract', () => {
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

  async function signupUser() {
    const email = `e2e+keyreuse-${Date.now()}-${Math.random()}@example.com`;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    return signup.json();
  }

  async function createAdminToken() {
    const { user } = await signupUser();
    const updated = await prisma.user.update({ where: { id: user.id }, data: { roles: [Roles.ADMIN] } });
    return app.jwt.sign({ sub: updated.id, email: updated.email, roles: [Roles.ADMIN], status: updated.status });
  }

  function createUpload(token, videoKey, title = 'Upload') {
    return app.inject({
      method: 'POST',
      url: '/admin/tutorials',
      headers: { authorization: `Bearer ${token}` },
      payload: { title, videoSource: 'upload', videoKey },
    });
  }

  it('rejects creating a second tutorial with an already used videoKey', async () => {
    const token = await createAdminToken();
    expect((await createUpload(token, KEY_A)).statusCode).toBe(201);

    const response = await createUpload(token, KEY_A, 'Duplicate');

    expect(response.statusCode).toBe(400);
    expect(response.json().messageCode).toBe('tutorial.invalidVideoKey');
  });

  it('rejects updating a tutorial to a videoKey used by another one', async () => {
    const token = await createAdminToken();
    await createUpload(token, KEY_A);
    const second = await createUpload(token, KEY_B, 'Second');

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/tutorials/${second.json().id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { videoSource: 'upload', videoKey: KEY_A },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().messageCode).toBe('tutorial.invalidVideoKey');
  });

  it('allows re-submitting the tutorial own videoKey on update', async () => {
    const token = await createAdminToken();
    const created = await createUpload(token, KEY_A);

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/tutorials/${created.json().id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Renamed', videoSource: 'upload', videoKey: KEY_A },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns the unified error contract on 403 for non-admins', async () => {
    const { token } = await signupUser();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/tutorials',
      headers: { authorization: `Bearer ${token.accessToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(expect.objectContaining({
      error: expect.any(String),
      messageCode: expect.any(String),
      message: expect.any(String),
      details: expect.anything(),
    }));
  });
});

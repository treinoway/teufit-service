import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken } from '../helpers/admin-users.js';
import { createUser, auth, expectErrorContract } from '../helpers/nutrition-e2e.js';
import config from '../../config/index.js';
import { Roles } from '../../src/constants/roles.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const INVITE_REQUIRED = 'INVITE_REQUIRED';
const INVITE_REQUIRED_MESSAGE_CODE = 'invite.required';

e2eDescribe('e2e: PATCH /become-nutritionist beta gate', () => {
  let app;
  let adminToken;
  let originalGateEnabled;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    ({ accessToken: adminToken } = await createAdminWithToken(app));
    originalGateEnabled = config.betaInviteGate.enabled;
  });

  async function withGateEnabled(run) {
    config.betaInviteGate.enabled = true;
    try {
      return await run();
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
  }

  async function redeemInviteFor(user) {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/trainer-invites',
      headers: auth(adminToken),
      payload: { email: user.email },
    });
    expect(created.statusCode).toBe(201);
    const redeemed = await app.inject({
      method: 'POST',
      url: '/invite/redeem',
      headers: auth(user.accessToken),
      payload: { code: created.json().code },
    });
    expect(redeemed.statusCode).toBe(200);
  }

  it('should answer 403 INVITE_REQUIRED for a user without beta access', async () => {
    const user = await createUser(app);

    const res = await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(user.accessToken) }),
    );

    expectErrorContract(res, { statusCode: 403, error: INVITE_REQUIRED, messageCode: INVITE_REQUIRED_MESSAGE_CODE });
  });

  it.each([
    ['pt-BR', /treinador/i],
    ['en-US', /trainer/i],
  ])('should not mention a trainer invite in the %s message of the nutritionist gate', async (language, trainerWording) => {
    const user = await createUser(app);

    const res = await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: { ...auth(user.accessToken), 'app-language': language } }),
    );

    const body = expectErrorContract(res, { statusCode: 403, error: INVITE_REQUIRED, messageCode: INVITE_REQUIRED_MESSAGE_CODE });
    expect(body.message).not.toMatch(trainerWording);
  });

  it('should not grant the nutritionist role to a user without beta access', async () => {
    const user = await createUser(app);
    await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(user.accessToken) }),
    );

    const probe = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(user.accessToken) });

    expect(probe.statusCode).toBe(403);
  });

  it('should grant the nutritionist role to a user with beta access', async () => {
    const user = await createUser(app);
    await redeemInviteFor(user);

    const res = await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(user.accessToken) }),
    );

    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/me', headers: auth(res.json().token.accessToken) });
    expect(me.json().roles).toContain(Roles.NUTRITIONIST);
  });

  it('should answer 401 without authentication', async () => {
    const res = await withGateEnabled(() => app.inject({ method: 'PATCH', url: '/become-nutritionist' }));

    expect(res.statusCode).toBe(401);
  });
});

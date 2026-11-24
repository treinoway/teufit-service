import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken } from '../helpers/admin-users.js';
import { createUser, auth } from '../helpers/nutrition-e2e.js';
import config from '../../config/index.js';
import { Roles } from '../../src/constants/roles.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const INVITE_REQUIRED = 'INVITE_REQUIRED';
const INVITE_REQUIRED_MESSAGE_CODE = 'invite.required';

e2eDescribe('e2e: PATCH /become-nutritionist without the beta gate (open signup)', () => {
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

  it('should not answer INVITE_REQUIRED for a user without an invite, even with the gate flag on', async () => {
    const user = await createUser(app);

    const res = await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(user.accessToken) }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().error).not.toBe(INVITE_REQUIRED);
  });

  it.each([
    ['pt-BR', ptBR, /treinador/i],
    ['en-US', enUS, /trainer/i],
  ])('should keep the %s invite.required message free of trainer wording (no route answers it any more)', (_language, locale, trainerWording) => {
    expect(locale.errors[INVITE_REQUIRED_MESSAGE_CODE]).toEqual(expect.any(String));
    expect(locale.errors[INVITE_REQUIRED_MESSAGE_CODE]).not.toMatch(trainerWording);
  });

  it('should grant the nutritionist role to a user without an invite', async () => {
    const user = await createUser(app);
    const res = await withGateEnabled(() =>
      app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(user.accessToken) }),
    );

    const probe = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(res.json().token.accessToken) });

    expect(probe.statusCode).toBe(200);
  });

  it('should grant the nutritionist role to a user who redeemed an invite', async () => {
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

import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import config from '../../config/index.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const BOOTSTRAP_EMAIL = 'n.santos1897@gmail.com';
const PASSWORD = 'StrongPassw0rd!';

e2eDescribe('e2e: trainer invite system (closed beta)', () => {
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

  async function signup(email, password = PASSWORD) {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });
    expect(res.statusCode).toBe(201);
    return { userId: res.json().user.id, accessToken: res.json().token.accessToken };
  }

  // Bootstrap-admin signup + self-grant, mirroring test/e2e/grant-admin.e2e.test.js.
  async function makeAdmin() {
    const { accessToken } = await signup(BOOTSTRAP_EMAIL);
    const grant = await app.inject({
      method: 'POST',
      url: '/me/grant-admin',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(grant.statusCode).toBe(200);
    return grant.json().token.accessToken;
  }

  function createInvite(adminToken, email) {
    return app.inject({
      method: 'POST',
      url: '/admin/trainer-invites',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email },
    });
  }

  function redeemInvite(accessToken, code) {
    return app.inject({
      method: 'POST',
      url: '/invite/redeem',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code },
    });
  }

  function getMe(accessToken) {
    return app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  it('admin creates an invite — 201 with a plain code', async () => {
    const adminToken = await makeAdmin();

    const response = await createInvite(adminToken, 'invitee@example.com');

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.invite).toMatchObject({ email: 'invitee@example.com', status: 'pending' });
    expect(body.code).toMatch(/^TF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);

    const persisted = await prisma.trainerInvite.findUnique({ where: { id: body.invite.id } });
    expect(persisted).not.toBeNull();
    expect(persisted.codeHash).not.toBe(body.code);
  });

  it('non-admin (plain trainer or student) hitting POST /admin/trainer-invites gets 403', async () => {
    const adminToken = await makeAdmin();
    const inviteRes = await createInvite(adminToken, 'plain-user@example.com');
    const { code } = inviteRes.json();

    const { accessToken: plainToken } = await signup('plain-user@example.com');
    const redeemRes = await redeemInvite(plainToken, code);
    expect(redeemRes.statusCode).toBe(200);
    const trainerToken = redeemRes.json().token.accessToken;

    const asTrainer = await createInvite(trainerToken, 'someone-else@example.com');
    expect(asTrainer.statusCode).toBe(403);

    const { accessToken: studentToken } = await signup('a-student@example.com');
    const asStudent = await createInvite(studentToken, 'someone-else@example.com');
    expect(asStudent.statusCode).toBe(403);
  });

  it('a freshly signed-up, non-exempt, un-invited user gets 403 invite.required on PATCH /become-trainer', async () => {
    // The beta invite gate defaults OFF in the test environment (see
    // config/environments/test.js) so the ~29 pre-existing e2e fixtures that
    // self-promote via PATCH /become-trainer keep working. This is the one
    // assertion that actually exercises the gate, so flip it on just for this
    // test and restore it afterwards — mirrors the same mutation pattern used
    // in test/middleware/auth-middleware.test.js's requireBetaAccess suite.
    config.betaInviteGate.enabled = true;
    try {
      const { accessToken } = await signup('fresh-user@example.com');

      const response = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().messageCode).toBe('invite.required');
    } finally {
      config.betaInviteGate.enabled = false;
    }
  });

  it('redeeming an unknown code returns 404 invite.notFound', async () => {
    const { accessToken } = await signup('redeemer@example.com');

    const response = await redeemInvite(accessToken, 'TF-ZZZZ-ZZZZ-99');

    expect(response.statusCode).toBe(404);
    expect(response.json().messageCode).toBe('invite.notFound');
  });

  it('redeems a valid invite — grants trainer role, activates betaAccess, and re-issued token works on a trainer-only route', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'new-trainer@example.com')).json();

    const { accessToken: preRedeemToken } = await signup('new-trainer@example.com');
    const preMe = await getMe(preRedeemToken);
    expect(preMe.json().betaAccess).toBe(false);
    expect(preMe.json().roles).not.toContain('trainer');

    const redeemRes = await redeemInvite(preRedeemToken, code);
    expect(redeemRes.statusCode).toBe(200);
    const body = redeemRes.json();
    expect(body.betaAccess).toBe(true);
    expect(body.activeProfile).toBe('trainer');
    expect(body.token.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');

    const newAccessToken = body.token.accessToken;

    const meAfter = await getMe(newAccessToken);
    expect(meAfter.statusCode).toBe(200);
    expect(meAfter.json().betaAccess).toBe(true);
    expect(meAfter.json().roles).toContain('trainer');

    const trainerRoute = await app.inject({
      method: 'GET',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${newAccessToken}` },
    });
    expect(trainerRoute.statusCode).toBe(200);
  });

  it('GET /me reflects betaAccess: true after redemption', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'beta-check@example.com')).json();
    const { accessToken } = await signup('beta-check@example.com');

    const redeemRes = await redeemInvite(accessToken, code);
    const newAccessToken = redeemRes.json().token.accessToken;

    const me = await getMe(newAccessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().betaAccess).toBe(true);
  });

  it('email mismatch: a different logged-in user cannot redeem an invite bound to another email', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'a@x.com')).json();

    const { accessToken: otherUserToken } = await signup('b@x.com');

    const response = await redeemInvite(otherUserToken, code);

    expect(response.statusCode).toBe(403);
    expect(response.json().messageCode).toBe('invite.emailMismatch');
  });

  it('redeeming twice with the same user is idempotent — 200 both times', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'idempotent@example.com')).json();
    const { accessToken } = await signup('idempotent@example.com');

    const first = await redeemInvite(accessToken, code);
    expect(first.statusCode).toBe(200);

    const second = await redeemInvite(first.json().token.accessToken, code);
    expect(second.statusCode).toBe(200);
    expect(second.json().betaAccess).toBe(true);
    expect(second.json().activeProfile).toBe('trainer');
  });

  it('a second, different user cannot redeem an already-accepted invite — 409 invite.alreadyAccepted', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'shared@example.com')).json();

    const { accessToken: firstUserToken } = await signup('shared@example.com');
    const firstRedeem = await redeemInvite(firstUserToken, code);
    expect(firstRedeem.statusCode).toBe(200);

    // A second account happens to know the same code (e.g. leaked/shared) but
    // is logged in as a different user than the one who redeemed it.
    const { accessToken: secondUserToken } = await signup('someone-else-entirely@example.com');
    const secondRedeem = await redeemInvite(secondUserToken, code);

    expect(secondRedeem.statusCode).toBe(409);
    expect(secondRedeem.json().messageCode).toBe('invite.alreadyAccepted');
  });

  it('admin revoke: revoking a pending invite returns 200, and the revoked code then fails with 403 invite.revoked', async () => {
    const adminToken = await makeAdmin();
    const { invite, code } = (await createInvite(adminToken, 'revoke-me@example.com')).json();

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/admin/trainer-invites/${invite.id}/revoke`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().invite.status).toBe('revoked');

    const { accessToken } = await signup('revoke-me@example.com');
    const redeemRes = await redeemInvite(accessToken, code);

    expect(redeemRes.statusCode).toBe(403);
    expect(redeemRes.json().messageCode).toBe('invite.revoked');
  });

  it('re-inviting the same email supersedes the prior pending invite: old code stops working, new code redeems', async () => {
    const adminToken = await makeAdmin();
    const first = await createInvite(adminToken, 'resend@example.com');
    expect(first.statusCode).toBe(201);
    const oldCode = first.json().code;

    const second = await createInvite(adminToken, 'resend@example.com');
    expect(second.statusCode).toBe(201);
    const newCode = second.json().code;
    expect(newCode).not.toBe(oldCode);

    const { accessToken: userA } = await signup('resend@example.com');
    const oldAttempt = await redeemInvite(userA, oldCode);
    expect(oldAttempt.statusCode).toBe(403);
    expect(oldAttempt.json().messageCode).toBe('invite.revoked');

    const newAttempt = await redeemInvite(userA, newCode);
    expect(newAttempt.statusCode).toBe(200);
    expect(newAttempt.json().betaAccess).toBe(true);
  });

  it('creating a second invite while one is already accepted for that email conflicts with 409 invite.alreadyActiveForEmail', async () => {
    const adminToken = await makeAdmin();
    const { code } = (await createInvite(adminToken, 'already-active@example.com')).json();

    const { accessToken } = await signup('already-active@example.com');
    const redeemRes = await redeemInvite(accessToken, code);
    expect(redeemRes.statusCode).toBe(200);

    const secondInviteRes = await createInvite(adminToken, 'already-active@example.com');

    expect(secondInviteRes.statusCode).toBe(409);
    expect(secondInviteRes.json().messageCode).toBe('invite.alreadyActiveForEmail');
  });

  it('GET /admin/trainer-invites lists and filters invites for admins', async () => {
    const adminToken = await makeAdmin();
    await createInvite(adminToken, 'list-a@example.com');
    await createInvite(adminToken, 'list-b@example.com');

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/trainer-invites',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.page).toBe(1);

    const filteredRes = await app.inject({
      method: 'GET',
      url: '/admin/trainer-invites?email=list-a@example.com',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filteredRes.statusCode).toBe(200);
    expect(filteredRes.json().total).toBe(1);
    expect(filteredRes.json().items[0].email).toBe('list-a@example.com');
  });

  it('returns 401 for admin invite endpoints without auth', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/trainer-invites', payload: { email: 'x@y.com' } });
    expect(response.statusCode).toBe(401);
  });

  it('returns 400 when creating an invite with an invalid email', async () => {
    const adminToken = await makeAdmin();
    const response = await createInvite(adminToken, 'not-an-email');
    expect(response.statusCode).toBe(400);
  });
});

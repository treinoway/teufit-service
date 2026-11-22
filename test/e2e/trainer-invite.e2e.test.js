import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteStatus, InviteMessageCode } from '../../src/constants/trainer-invite.js';
import { signupVerified } from '../helpers/signup-user.js';

// Mirrors normalizeInviteCode()/hashInviteCode() in
// src/services/trainer-invite-service.js (not exported) — needed to seed a
// TrainerInvite row directly via Prisma with a codeHash the service will
// recognize when the plaintext code is later sent to the API.
function hashInviteCodeForSeed(code) {
  const normalized = code.trim().toUpperCase().replace(/^TF-?/, '').replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ADMIN_EMAIL = 'admin@example.com';
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
    const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password } });
    expect(res.statusCode).toBe(201);
    return { userId: res.json().user.id, accessToken: res.json().token.accessToken };
  }

  // Admin is granted purely by role. There is no self-grant endpoint: seed the
  // ADMIN role directly in the DB (mirrors the manual prod bootstrap), then log
  // in again so the issued token reflects the new role.
  async function makeAdmin() {
    const { userId } = await signup(ADMIN_EMAIL);
    await prisma.user.update({
      where: { id: userId },
      data: { roles: { set: [Roles.ADMIN] } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token.accessToken;
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

  // Deliberately sends NO Authorization header — /invite/preview is public.
  function previewInvite(code) {
    return app.inject({
      method: 'GET',
      url: `/invite/preview?code=${encodeURIComponent(code)}`,
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

  it('a freshly signed-up, un-invited user becomes a trainer on PATCH /become-trainer even with the gate flag on (open signup)', async () => {
    // The invite gate was removed from /become-trainer; the flag is flipped on
    // to prove it no longer matters. Capture/restore the prior value so state
    // doesn't leak into other tests.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
      const { accessToken } = await signup('fresh-user@example.com');

      const response = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().messageCode).toBeUndefined();
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
  });

  it('redeeming an unknown code returns 404 invite.notFound', async () => {
    const { accessToken } = await signup('redeemer@example.com');

    const response = await redeemInvite(accessToken, 'TF-ZZZZ-ZZZZ-99');

    expect(response.statusCode).toBe(404);
    expect(response.json().messageCode).toBe('invite.notFound');
  });

  it('redeems a valid invite — grants trainer role, activates betaAccess, and re-issued token works on a trainer-only route', async () => {
    // hasBetaAccess() (src/helpers/beta-access.js) short-circuits to `true`
    // for every authenticated user whenever config.betaInviteGate.enabled is
    // false — and that's the default in the test environment (see
    // config/environments/test.js). The pre-redemption assertion below is
    // only meaningful with the gate actually enabled, so flip it on for this
    // test and restore it afterward, mirroring the pattern used above for
    // the PATCH /become-trainer gate assertion. Capture/restore the prior
    // value rather than hardcoding `false`.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'new-trainer@example.com')).json();

      const { accessToken: preRedeemToken } = await signup('new-trainer@example.com');
      const preMe = await getMe(preRedeemToken);
      expect(preMe.json().betaAccess).toBe(true);
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
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
  });

  it('GET /me reflects betaAccess: true for a plain roles:[] user when the beta invite gate kill-switch is disabled', async () => {
    // Regression coverage for the kill-switch short-circuit in hasBetaAccess
    // (src/helpers/beta-access.js): when config.betaInviteGate.enabled is
    // false, EVERY authenticated user gets betaAccess: true — including a
    // freshly signed-up user with no roles and no accepted invite. Set the
    // flag explicitly (don't just assert the test-env default) so this test
    // still proves the point if that default ever changes, and so it doesn't
    // depend on a prior test's cleanup having run.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = false;
    try {
      const { accessToken } = await signup('kill-switch-user@example.com');

      const me = await getMe(accessToken);

      expect(me.statusCode).toBe(200);
      expect(me.json().betaAccess).toBe(true);
      expect(me.json().roles).not.toContain('trainer');
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
  });

  it('GET /me reflects betaAccess: true after redemption', async () => {
    // Must run with the gate ENABLED — otherwise hasBetaAccess() short-
    // circuits to true for everyone regardless of redemption, and this
    // assertion would pass even if redeemInvite() were deleted entirely.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'beta-check@example.com')).json();
      const { accessToken } = await signup('beta-check@example.com');

      const preMe = await getMe(accessToken);
      expect(preMe.json().betaAccess).toBe(true);

      const redeemRes = await redeemInvite(accessToken, code);
      const newAccessToken = redeemRes.json().token.accessToken;

      const me = await getMe(newAccessToken);
      expect(me.statusCode).toBe(200);
      expect(me.json().betaAccess).toBe(true);
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
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
    // Gate must be ENABLED so `betaAccess: true` on the second redemption
    // actually proves the accepted invite still grants access, rather than
    // trivially passing via the disabled-gate short-circuit regardless of
    // what redeemInvite() does.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'idempotent@example.com')).json();
      const { accessToken } = await signup('idempotent@example.com');

      const first = await redeemInvite(accessToken, code);
      expect(first.statusCode).toBe(200);

      const second = await redeemInvite(first.json().token.accessToken, code);
      expect(second.statusCode).toBe(200);
      expect(second.json().betaAccess).toBe(true);
      expect(second.json().activeProfile).toBe('trainer');
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
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
    // Gate must be ENABLED so `betaAccess: true` on the new-code redemption
    // actually proves the new invite grants access, rather than trivially
    // passing via the disabled-gate short-circuit.
    const originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    try {
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
    } finally {
      config.betaInviteGate.enabled = originalGateEnabled;
    }
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

  describe('GET /invite/preview (public, unauthenticated)', () => {
    it('returns 200 with the exact { email, invitedByName, expiresAt, accountExists } shape for a valid pending invite, with no Authorization header sent', async () => {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'preview-valid@example.com')).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(['accountExists', 'email', 'expiresAt', 'invitedByName'].sort());
      expect(body.email).toBe('preview-valid@example.com');
      expect(typeof body.expiresAt).toBe('string');
      expect(new Date(body.expiresAt).toString()).not.toBe('Invalid Date');
      expect(typeof body.accountExists).toBe('boolean');
    });

    it('returns invitedByName as trimmed "first last" when the inviter has a name set', async () => {
      const adminToken = await makeAdmin();
      await prisma.user.update({
        where: { email: ADMIN_EMAIL },
        data: { firstName: 'Ada', lastName: 'Lovelace' },
      });
      const { code } = (await createInvite(adminToken, 'preview-named-inviter@example.com')).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().invitedByName).toBe('Ada Lovelace');
    });

    it('returns invitedByName: null when the inviter has no name set', async () => {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'preview-nameless-inviter@example.com')).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().invitedByName).toBeNull();
    });

    it('returns 404 invite.notFound for an unknown code', async () => {
      const response = await previewInvite('TF-ZZZZ-ZZZZ-99');

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: 'INVITE_NOT_FOUND',
        messageCode: 'invite.notFound',
      });
    });

    it('returns 403 invite.revoked for a revoked invite', async () => {
      const adminToken = await makeAdmin();
      const { invite, code } = (await createInvite(adminToken, 'preview-revoked@example.com')).json();
      const revokeRes = await app.inject({
        method: 'POST',
        url: `/admin/trainer-invites/${invite.id}/revoke`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(revokeRes.statusCode).toBe(200);

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(403);
      expect(response.json().messageCode).toBe('invite.revoked');
    });

    it('returns 409 invite.alreadyAccepted for an already-redeemed invite', async () => {
      const originalGateEnabled = config.betaInviteGate.enabled;
      config.betaInviteGate.enabled = true;
      try {
        const adminToken = await makeAdmin();
        const { code } = (await createInvite(adminToken, 'preview-accepted@example.com')).json();
        const { accessToken } = await signup('preview-accepted@example.com');
        const redeemRes = await redeemInvite(accessToken, code);
        expect(redeemRes.statusCode).toBe(200);

        const response = await previewInvite(code);

        expect(response.statusCode).toBe(409);
        expect(response.json().messageCode).toBe('invite.alreadyAccepted');
      } finally {
        config.betaInviteGate.enabled = originalGateEnabled;
      }
    });

    it('returns 403 invite.expired for an expired pending invite, and never mutates the invite row (read-only)', async () => {
      await makeAdmin();
      const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
      const code = 'TF-EXPI-REDX-99';
      await prisma.trainerInvite.create({
        data: {
          email: 'preview-expired@example.com',
          codeHash: hashInviteCodeForSeed(code),
          invitedByUserId: admin.id,
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      });

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(403);
      expect(response.json().messageCode).toBe('invite.expired');

      // Critical read-only guarantee: unlike POST /invite/redeem, preview
      // must never flip an expired pending invite's status to 'expired'.
      const persisted = await prisma.trainerInvite.findUnique({
        where: { codeHash: hashInviteCodeForSeed(code) },
      });
      expect(persisted.status).toBe('pending');
    });

    it('returns 400 VALIDATION_ERROR when the code querystring is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/invite/preview' });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
    });

    it('returns accountExists: true when a user already exists for the invited email', async () => {
      const adminToken = await makeAdmin();
      await signup('preview-existing-account@example.com');
      const { code } = (await createInvite(adminToken, 'preview-existing-account@example.com')).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().accountExists).toBe(true);
    });

    it('returns accountExists: false when no user exists for the invited email', async () => {
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, 'preview-no-account@example.com')).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().accountExists).toBe(false);
    });

    it('does not treat "_" in the invite email as a wildcard matching a differently-punctuated existing user (wildcard-safety regression)', async () => {
      const suffix = Date.now();
      // Differ only by "." vs "_" at the same position — proves the lookup is
      // an exact match, not an ILIKE pattern where "_" matches any character.
      const userEmail = `joao.silva.${suffix}@gmail.com`;
      const inviteEmail = `joao_silva.${suffix}@gmail.com`;

      await signup(userEmail);
      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, inviteEmail)).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().accountExists).toBe(false);
    });

    it('returns accountExists: true for a legacy mixed-case stored user email matched case-insensitively', async () => {
      const suffix = Date.now();
      const mixedCaseEmail = `Mixed.Case.${suffix}@Example.com`;

      // /auth/signup always normalizes to lowercase, so a mixed-case row can
      // only exist as legacy data — bypass the API and write it directly.
      await prisma.user.create({
        data: { email: mixedCaseEmail, roles: [], status: 'pending' },
      });

      const adminToken = await makeAdmin();
      const { code } = (await createInvite(adminToken, mixedCaseEmail)).json();

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(200);
      expect(response.json().accountExists).toBe(true);
    });

    it('returns 403 invite.expired for an invite whose STORED status is already "expired" (not merely past expiresAt)', async () => {
      await makeAdmin();
      const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
      const code = 'TF-STOR-EXPD-77';
      await prisma.trainerInvite.create({
        data: {
          email: 'preview-stored-expired@example.com',
          codeHash: hashInviteCodeForSeed(code),
          status: 'expired',
          invitedByUserId: admin.id,
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      });

      const response = await previewInvite(code);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: 'INVITE_EXPIRED',
        messageCode: 'invite.expired',
      });
    });
  });

  describe('claim race hardening', () => {
    const RACE_ITERATIONS = 5;
    const HOUR_MS = 60 * 60 * 1000;
    let restoreDelegate;

    afterEach(() => {
      restoreDelegate?.();
      restoreDelegate = undefined;
    });

    // Prisma model delegates are lazy proxies that vi.spyOn cannot wrap (and the
    // suite auto-resets spies), so temporarily shadow the delegate with a
    // pass-through proxy whose first findUnique returns a canned (stale) row.
    // Undone by the afterEach below.
    function serveStaleFirstInviteRead(staleRow) {
      const realDelegate = prisma.trainerInvite;
      let served = false;
      const proxied = new Proxy(realDelegate, {
        get(target, prop) {
          if (prop === 'findUnique') {
            return (args) => {
              if (!served) {
                served = true;
                return Promise.resolve(staleRow);
              }
              return target.findUnique(args);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.defineProperty(prisma, 'trainerInvite', { configurable: true, enumerable: true, get: () => proxied });
      restoreDelegate = () => {
        Object.defineProperty(prisma, 'trainerInvite', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: realDelegate,
        });
      };
    }

    function revokeInvite(adminToken, inviteId) {
      return app.inject({
        method: 'POST',
        url: `/admin/trainer-invites/${inviteId}/revoke`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
    }

    function signupWithInvite(code) {
      return app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code, password: PASSWORD } });
    }

    it('lets exactly one of a concurrent signup-with-invite and admin revoke win, never leaving a revoked invite with a userId', async () => {
      const adminToken = await makeAdmin();

      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const email = `race-${i}-${Date.now()}@example.com`;
        const { invite, code } = (await createInvite(adminToken, email)).json();

        const [signupRes, revokeRes] = await Promise.all([signupWithInvite(code), revokeInvite(adminToken, invite.id)]);

        const persisted = await prisma.trainerInvite.findUnique({ where: { id: invite.id } });
        const createdUser = await prisma.user.findUnique({ where: { email } });

        // Invariant: revoked never coexists with a claimed userId.
        expect(persisted.status === InviteStatus.REVOKED && persisted.userId !== null).toBe(false);

        if (signupRes.statusCode === 201) {
          expect(revokeRes.statusCode).toBe(409);
          expect(persisted.status).toBe(InviteStatus.ACCEPTED);
          expect(persisted.userId).toBe(createdUser.id);
        } else {
          expect(signupRes.statusCode).toBe(403);
          expect(signupRes.json().messageCode).toBe(InviteMessageCode.REVOKED);
          expect(revokeRes.statusCode).toBe(200);
          expect(persisted.status).toBe(InviteStatus.REVOKED);
          expect(persisted.userId).toBeNull();
          // The rolled-back signup must leave no account behind.
          expect(createdUser).toBeNull();
        }
      }
    });

    it('returns 403 invite.revoked and creates no account when signup-with-invite meets an already revoked invite at claim time', async () => {
      const adminToken = await makeAdmin();
      const email = 'claim-revoked@example.com';
      const { invite, code } = (await createInvite(adminToken, email)).json();
      const staleRead = await prisma.trainerInvite.findUnique({ where: { id: invite.id } });
      await revokeInvite(adminToken, invite.id);
      // The first (load) read sees the stale pending row; the claim then loses to the revoke.
      serveStaleFirstInviteRead(staleRead);

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(403);
      expect(res.json().messageCode).toBe(InviteMessageCode.REVOKED);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    describe('invite expiring between the load and the claim', () => {
      async function seedExpiredRowSeenAsPending(code, email) {
        const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
        const row = await prisma.trainerInvite.create({
          data: {
            email,
            codeHash: hashInviteCodeForSeed(code),
            invitedByUserId: admin.id,
            expiresAt: new Date(Date.now() - 60 * 1000),
          },
        });
        // The load read still sees an unexpired pending invite (as if it expired
        // right after it); only the DB-side conditional claim notices.
        const staleRead = { ...row, expiresAt: new Date(Date.now() + HOUR_MS) };
        serveStaleFirstInviteRead(staleRead);
        return row;
      }

      it('POST /auth/signup/invite returns 403 invite.expired, flips the invite to expired and creates no account', async () => {
        await makeAdmin();
        const email = 'expire-signup@example.com';
        const row = await seedExpiredRowSeenAsPending('TF-EXPS-IGNU-01', email);

        const res = await signupWithInvite('TF-EXPS-IGNU-01');

        expect(res.statusCode).toBe(403);
        expect(res.json().messageCode).toBe(InviteMessageCode.EXPIRED);
        const persisted = await prisma.trainerInvite.findUnique({ where: { id: row.id } });
        expect(persisted.status).toBe(InviteStatus.EXPIRED);
        expect(persisted.userId).toBeNull();
        expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      });

      it('POST /invite/redeem returns 403 invite.expired and flips the invite to expired', async () => {
        await makeAdmin();
        const email = 'expire-redeem@example.com';
        const { accessToken } = await signup(email);
        const row = await seedExpiredRowSeenAsPending('TF-EXPR-EDEM-02', email);

        const res = await redeemInvite(accessToken, 'TF-EXPR-EDEM-02');

        expect(res.statusCode).toBe(403);
        expect(res.json().messageCode).toBe(InviteMessageCode.EXPIRED);
        const persisted = await prisma.trainerInvite.findUnique({ where: { id: row.id } });
        expect(persisted.status).toBe(InviteStatus.EXPIRED);
        expect(persisted.userId).toBeNull();
      });
    });
  });

  describe('GET /admin/trainer-invites email filter — wildcard safety', () => {
    it('does not wildcard-match an invite whose email differs only by "_" vs "." at the same position', async () => {
      const suffix = Date.now();
      const adminToken = await makeAdmin();
      const dotEmail = `filter.name.${suffix}@example.com`;
      await createInvite(adminToken, dotEmail);

      const response = await app.inject({
        method: 'GET',
        url: `/admin/trainer-invites?email=${encodeURIComponent(`filter_name.${suffix}@example.com`)}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(0);
      expect(response.json().items).toEqual([]);
    });
  });
});

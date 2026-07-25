import { describe, it, expect, vi, beforeEach } from 'vitest';

import { authenticate, requireActiveUser, requireRole, requireBetaAccess } from '../../api/middleware/auth.js';
import config from '../../config/index.js';
import { InviteMessageCode } from '../../src/constants/trainer-invite.js';

vi.mock('../../src/helpers/beta-access.js', () => {
  return {
    hasBetaAccess: vi.fn(),
  };
});

import { hasBetaAccess } from '../../src/helpers/beta-access.js';

function makeSession(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  };
}

function makeReply() {
  const reply = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
  return reply;
}

describe('api/middleware/auth.js', () => {
  it('authenticate sets request.user when session user exists', async () => {
    const request = { session: makeSession({ user: { id: 'u1', status: 'active', roles: ['trainer'] } }) };
    const reply = makeReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(null);
    expect(request.user).toEqual({ id: 'u1', status: 'active', roles: ['trainer'] });
  });

  it('authenticate accepts Bearer token and sets request.user from jwt payload', async () => {
    let jwtVerifyArgs;
    const request = {
      session: makeSession({}),
      headers: { authorization: 'Bearer token' },
      jwtVerify: async (args) => {
        jwtVerifyArgs = args;
        return { sub: 'u2', email: 'm@b.com', roles: ['trainer'], status: 'pending' };
      },
    };
    const reply = makeReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(null);
    expect(jwtVerifyArgs).toEqual({ token: 'token' });
    expect(request.user).toEqual({ id: 'u2', email: 'm@b.com', roles: ['trainer'], status: 'pending' });
  });

  it('requireActiveUser blocks when status is pending', async () => {
    const mw = requireActiveUser();

    const request = { session: makeSession({ user: { id: 'u1', status: 'pending', roles: ['trainer'] } }) };
    const reply = makeReply();

    await mw(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({ error: 'Account not active', status: 'pending' });
  });

  it('requireRole blocks when role mismatches', async () => {
    const mw = requireRole('trainer');

    const request = { session: makeSession({ user: { id: 'u1', status: 'active', roles: ['student'] } }) };
    const reply = makeReply();

    await mw(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({ error: 'Forbidden' });
  });

  it('requireRole allows when user has the required role', async () => {
    const mw = requireRole('trainer');

    const request = { session: makeSession({ user: { id: 'u1', status: 'active', roles: ['trainer'] } }) };
    const reply = makeReply();

    await mw(request, reply);

    expect(reply.statusCode).toBe(null);
    expect(request.user).toEqual({ id: 'u1', status: 'active', roles: ['trainer'] });
  });

  it('requireRole allows when user has multiple roles including the required one', async () => {
    const mw = requireRole('trainer');

    const request = { session: makeSession({ user: { id: 'u1', status: 'active', roles: ['student', 'trainer'] } }) };
    const reply = makeReply();

    await mw(request, reply);

    expect(reply.statusCode).toBe(null);
    expect(request.user).toEqual({ id: 'u1', status: 'active', roles: ['student', 'trainer'] });
  });

  it('requireRole accepts array of allowed roles', async () => {
    const mw = requireRole(['trainer', 'admin']);

    const request = { session: makeSession({ user: { id: 'u1', status: 'active', roles: ['trainer'] } }) };
    const reply = makeReply();

    await mw(request, reply);

    expect(reply.statusCode).toBe(null);
  });

  // requireBetaAccess throws AppError instances directly (unlike the legacy
  // middlewares above, which call reply.status().send()) — assert on the
  // thrown error's shape, not on reply.statusCode.
  describe('requireBetaAccess', () => {
    beforeEach(() => {
      hasBetaAccess.mockReset();
      config.betaInviteGate.enabled = true;
    });

    it('allows through and sets request.user when hasBetaAccess resolves true', async () => {
      hasBetaAccess.mockResolvedValue(true);
      const mw = requireBetaAccess();
      const user = { id: 'u1', email: 'admin@example.com', roles: ['admin'] };
      const request = { session: makeSession({ user }) };

      await expect(mw(request)).resolves.toBeUndefined();

      expect(hasBetaAccess).toHaveBeenCalledWith(user);
      expect(request.user).toEqual(user);
    });

    it('throws ForbiddenAppError (invite.required) when hasBetaAccess resolves false', async () => {
      hasBetaAccess.mockResolvedValue(false);
      const mw = requireBetaAccess();
      const user = { id: 'u1', email: 'plain@example.com', roles: [] };
      const request = { session: makeSession({ user }) };

      await expect(mw(request)).rejects.toMatchObject({
        httpStatus: 403,
        error: 'INVITE_REQUIRED',
        messageCode: InviteMessageCode.REQUIRED,
      });
    });

    it('throws UnauthorizedAppError when there is no authenticated user', async () => {
      const mw = requireBetaAccess();
      const request = { session: makeSession({}) };

      await expect(mw(request)).rejects.toMatchObject({ httpStatus: 401 });
      expect(hasBetaAccess).not.toHaveBeenCalled();
    });

    // requireBetaAccess has no code of its own for the tester-email allowlist —
    // it delegates entirely to hasBetaAccess (see src/helpers/beta-access.js,
    // covered by test/helpers/beta-access.test.js). This test just documents
    // that the middleware honors whatever hasBetaAccess decides, including
    // when the true stems from tester-allowlist membership.
    it('allows a tester-allowlisted user through because it trusts whatever hasBetaAccess resolves', async () => {
      hasBetaAccess.mockResolvedValue(true);
      const mw = requireBetaAccess();
      const user = { id: 'u1', email: 'qa@example.com', roles: [] };
      const request = { session: makeSession({ user }) };

      await expect(mw(request)).resolves.toBeUndefined();

      expect(hasBetaAccess).toHaveBeenCalledWith(user);
      expect(request.user).toEqual(user);
    });

    it('is a no-op that allows through (even with no user) when the kill-switch disables the gate', async () => {
      config.betaInviteGate.enabled = false;
      const mw = requireBetaAccess();
      const request = { session: makeSession({}) };

      try {
        await expect(mw(request)).resolves.toBeUndefined();
        expect(hasBetaAccess).not.toHaveBeenCalled();
        expect(request.user).toBeUndefined();
      } finally {
        config.betaInviteGate.enabled = true;
      }
    });
  });
});

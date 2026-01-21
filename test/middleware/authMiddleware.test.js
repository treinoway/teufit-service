import { describe, it, expect } from 'vitest';

import { authenticate, requireActiveUser, requireRole } from '../../api/middleware/auth.js';

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
});

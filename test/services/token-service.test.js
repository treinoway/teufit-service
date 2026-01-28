import { describe, it, expect } from 'vitest';

import { issueAccessToken } from '../../src/services/token-service.js';

describe('tokenService', () => {
  it('issues a Bearer token with expiresIn', () => {
    const fastify = {
      jwt: {
        sign: (payload, opts) => {
          // minimal sanity checks
          if (!payload?.sub) throw new Error('missing sub');
          if (!opts?.expiresIn) throw new Error('missing expiresIn');
          return 'signed.jwt.token';
        },
      },
    };

    const user = { id: 'u1', email: 'a@b.com', roles: ['trainer'], status: 'pending' };
    const res = issueAccessToken({ fastify, user, expiresInSeconds: 60 });

    expect(res).toEqual({
      accessToken: 'signed.jwt.token',
      tokenType: 'Bearer',
      expiresIn: 60,
    });
  });
});

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildErrorPayload, normalizeError } from '../../src/errors/index.js';
import { perEmailRateLimiter } from '../../src/helpers/per-email-rate-limiter.js';
import { normalizeRateLimitIp, userRateLimitKey } from '../../src/helpers/rate-limit-key.js';
import { registerRateLimit } from '../../src/helpers/register-rate-limit.js';

const TIME_WINDOW = '1 minute';
const ANONYMOUS_MAX = 2;
const AUTHENTICATED_MAX = 4;
const ROUTE_MAX = 3;
const USER_HEADER = 'x-test-user';
const IP_A = '10.0.0.1';
const IP_B = '10.0.0.2';
const IP_C = '10.0.0.3';
const TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS';
const RATE_LIMIT_MESSAGE_CODE = 'request.rateLimitExceeded';

// Builds a Fastify app with the real error normalization and a user derived from a header.
async function buildApp({ withRateLimit = true, registerRoutes }) {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error, request.language);
    return reply.status(normalized.httpStatus).send(buildErrorPayload(normalized));
  });
  app.addHook('onRequest', async (request) => {
    const userId = request.headers[USER_HEADER];
    if (userId) request.user = { id: userId };
  });
  if (withRateLimit) {
    await registerRateLimit(app, {
      global: { max: ANONYMOUS_MAX, timeWindow: TIME_WINDOW },
      globalPerUser: { max: AUTHENTICATED_MAX },
    });
  }
  await registerRoutes(app);
  await app.ready();
  return app;
}

// Fires one request from a given IP, optionally as a user.
function hit(app, { url = '/ping', method = 'GET', ip, userId, payload }) {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: userId ? { [USER_HEADER]: userId } : {},
    payload,
  });
}

// Fires the same request n times and returns the status codes.
async function hitTimes(app, times, options) {
  const statuses = [];
  for (let i = 0; i < times; i += 1) {
    statuses.push((await hit(app, options)).statusCode);
  }
  return statuses;
}

describe('normalizeRateLimitIp', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(normalizeRateLimitIp('1.2.3.4')).toBe('1.2.3.4');
  });

  it('maps a dotted IPv4-mapped IPv6 address to IPv4', () => {
    expect(normalizeRateLimitIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('maps a hex IPv4-mapped IPv6 address to IPv4', () => {
    expect(normalizeRateLimitIp('::ffff:102:304')).toBe('1.2.3.4');
  });

  it('is case-insensitive for the IPv4-mapped prefix', () => {
    expect(normalizeRateLimitIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });

  it('reduces IPv6 to its /64 prefix', () => {
    expect(normalizeRateLimitIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  });

  it('gives abbreviated and expanded forms of the same prefix the same key', () => {
    const expanded = normalizeRateLimitIp('2001:0db8:0000:0000:0000:0000:0000:0001');
    const abbreviated = normalizeRateLimitIp('2001:db8::1');

    expect(expanded).toBe('2001:db8:0:0::/64');
    expect(abbreviated).toBe(expanded);
  });

  it('keeps the prefix when the abbreviation falls inside the first four groups', () => {
    expect(normalizeRateLimitIp('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(normalizeRateLimitIp('::1')).toBe('0:0:0:0::/64');
  });

  it('strips an IPv6 zone id', () => {
    expect(normalizeRateLimitIp('fe80::1%eth0')).toBe(normalizeRateLimitIp('fe80::1'));
  });

  it('lower-cases IPv6 hex digits', () => {
    expect(normalizeRateLimitIp('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
  });

  it('separates different /64 prefixes', () => {
    expect(normalizeRateLimitIp('2001:db8:1:2::1')).not.toBe(normalizeRateLimitIp('2001:db8:1:3::1'));
  });

  it('returns an empty string for a missing IP', () => {
    expect(normalizeRateLimitIp(undefined)).toBe('');
  });
});

describe('userRateLimitKey', () => {
  it('keys by authenticated user id, ignoring the IP', () => {
    const keyOf = userRateLimitKey('verify-email');

    expect(keyOf({ user: { id: 'user-1' }, ip: '1.1.1.1' })).toBe('verify-email:user-1');
    expect(keyOf({ user: { id: 'user-1' }, ip: '2.2.2.2' })).toBe('verify-email:user-1');
  });

  it('falls back to the IP when there is no authenticated user', () => {
    const keyOf = userRateLimitKey('verify-email');

    expect(keyOf({ ip: '1.1.1.1' })).toBe('verify-email:1.1.1.1');
    expect(keyOf({ user: {}, ip: '1.1.1.1' })).toBe('verify-email:1.1.1.1');
  });

  it('normalizes the fallback IP', () => {
    const keyOf = userRateLimitKey('verify-email');

    expect(keyOf({ ip: '::ffff:1.1.1.1' })).toBe('verify-email:1.1.1.1');
    expect(keyOf({ ip: '2001:db8:1:2::9' })).toBe('verify-email:2001:db8:1:2::/64');
  });

  it('separates counters by namespace', () => {
    const request = { user: { id: 'user-1' }, ip: '1.1.1.1' };

    expect(userRateLimitKey('verify-email')(request)).not.toBe(userRateLimitKey('verify-email-resend')(request));
  });
});

describe('global rate limiter keying', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  describe('route with its own rateLimit config', () => {
    const registerRoutes = async (instance) => {
      instance.get('/limited', { config: { rateLimit: { max: ROUTE_MAX, timeWindow: TIME_WINDOW } } }, async () => ({ ok: true }));
    };

    it('does not let users sharing an IP affect each other', async () => {
      app = await buildApp({ registerRoutes });

      const userA = await hitTimes(app, ROUTE_MAX + 1, { url: '/limited', ip: IP_A, userId: 'user-a' });
      const userB = await hit(app, { url: '/limited', ip: IP_A, userId: 'user-b' });
      const anonymousSameIp = await hit(app, { url: '/limited', ip: IP_A });

      expect(userA).toEqual([200, 200, 200, 429]);
      expect(userB.statusCode).toBe(200);
      expect(anonymousSameIp.statusCode).toBe(200);
    });

    it('limits one user rotating IPs by the per-user budget', async () => {
      app = await buildApp({ registerRoutes });
      const ips = [IP_A, IP_B, IP_C, '10.0.0.4'];

      const statuses = [];
      for (const ip of ips) {
        statuses.push((await hit(app, { url: '/limited', ip, userId: 'user-a' })).statusCode);
      }

      expect(statuses).toEqual([200, 200, 200, 429]);
    });
  });

  describe('route without its own config', () => {
    const registerRoutes = async (instance) => {
      instance.get('/ping', async () => ({ ok: true }));
    };

    it('limits anonymous requests per IP with the anonymous max', async () => {
      app = await buildApp({ registerRoutes });

      const statuses = await hitTimes(app, ANONYMOUS_MAX + 1, { ip: IP_A });

      expect(statuses).toEqual([200, 200, 429]);
    });

    it('keeps different anonymous IPs in separate counters', async () => {
      app = await buildApp({ registerRoutes });
      await hitTimes(app, ANONYMOUS_MAX + 1, { ip: IP_A });

      const other = await hit(app, { ip: IP_B });

      expect(other.statusCode).toBe(200);
    });

    it('uses the per-user max for authenticated requests', async () => {
      app = await buildApp({ registerRoutes });

      const statuses = await hitTimes(app, AUTHENTICATED_MAX + 1, { ip: IP_A, userId: 'user-a' });

      expect(statuses).toEqual([200, 200, 200, 200, 429]);
    });

    it('does not count authenticated requests against the anonymous IP counter', async () => {
      app = await buildApp({ registerRoutes });
      await hitTimes(app, AUTHENTICATED_MAX, { ip: IP_A, userId: 'user-a' });

      const anonymous = await hit(app, { ip: IP_A });

      expect(anonymous.statusCode).toBe(200);
    });

    it('shares one counter between IPv4 and its IPv4-mapped IPv6 form', async () => {
      app = await buildApp({ registerRoutes });
      await hit(app, { ip: '1.2.3.4' });
      await hit(app, { ip: '::ffff:1.2.3.4' });

      const third = await hit(app, { ip: '1.2.3.4' });

      expect(third.statusCode).toBe(429);
    });

    it('shares one counter across addresses in the same IPv6 /64', async () => {
      app = await buildApp({ registerRoutes });
      await hit(app, { ip: '2001:db8:1:2::1' });
      await hit(app, { ip: '2001:db8:1:2:ffff::9' });

      const third = await hit(app, { ip: '2001:db8:1:2::abcd' });

      expect(third.statusCode).toBe(429);
    });

    it('keeps different IPv6 /64 prefixes in separate counters', async () => {
      app = await buildApp({ registerRoutes });
      await hitTimes(app, ANONYMOUS_MAX + 1, { ip: '2001:db8:1:2::1' });

      const otherPrefix = await hit(app, { ip: '2001:db8:1:3::1' });

      expect(otherPrefix.statusCode).toBe(200);
    });
  });

  describe('hook ordering in a protected context', () => {
    const registerRoutes = async (instance) => {
      await instance.register(async (protectedScope) => {
        protectedScope.addHook('onRequest', async (request) => {
          const userId = request.headers['x-protected-user'];
          if (userId) request.user = { id: userId };
        });
        protectedScope.get('/protected', async () => ({ ok: true }));
      });
    };

    it('keys by the user set by the authenticate hook and applies the per-user max', async () => {
      app = await buildApp({ registerRoutes });
      const authenticatedHit = (userId, ip) =>
        app.inject({ method: 'GET', url: '/protected', remoteAddress: ip, headers: { 'x-protected-user': userId } });

      const statuses = [];
      for (let i = 0; i < AUTHENTICATED_MAX + 1; i += 1) {
        statuses.push((await authenticatedHit('user-a', i % 2 ? IP_A : IP_B)).statusCode);
      }
      const otherUser = await authenticatedHit('user-b', IP_A);

      expect(statuses).toEqual([200, 200, 200, 200, 429]);
      expect(otherUser.statusCode).toBe(200);
    });
  });

  describe('429 response', () => {
    const registerRoutes = async (instance) => {
      instance.get('/ping', async () => ({ ok: true }));
    };

    it('matches the unified error contract', async () => {
      app = await buildApp({ registerRoutes });
      await hitTimes(app, ANONYMOUS_MAX, { ip: IP_A });

      const response = await hit(app, { ip: IP_A });

      expect(response.statusCode).toBe(429);
      expect(Object.keys(response.json()).sort()).toEqual(['error', 'message', 'messageCode']);
      expect(response.json()).toMatchObject({ error: TOO_MANY_REQUESTS, messageCode: RATE_LIMIT_MESSAGE_CODE });
      expect(typeof response.json().message).toBe('string');
    });

    it('includes draft-spec RateLimit headers and retry-after', async () => {
      app = await buildApp({ registerRoutes });
      await hitTimes(app, ANONYMOUS_MAX, { ip: IP_A });

      const response = await hit(app, { ip: IP_A });

      expect(response.headers['ratelimit-limit']).toBe(String(ANONYMOUS_MAX));
      expect(response.headers['ratelimit-remaining']).toBe('0');
      expect(response.headers['ratelimit-reset']).toBeDefined();
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
});

describe('perEmailRateLimiter', () => {
  const EMAIL_MAX = 2;
  const EMAIL_LIMIT = { max: EMAIL_MAX, timeWindow: TIME_WINDOW };
  const EMAIL_NAMESPACE = 'login-email';
  const OTHER_NAMESPACE = 'forgot-password-email';
  let app;

  const registerRoutes = async (instance) => {
    const generousIpLimit = { max: 100, timeWindow: TIME_WINDOW };
    instance.post(
      '/login',
      { config: { rateLimit: generousIpLimit }, preHandler: perEmailRateLimiter(instance, EMAIL_NAMESPACE, EMAIL_LIMIT) },
      async () => ({ ok: true }),
    );
    instance.post(
      '/forgot',
      { config: { rateLimit: generousIpLimit }, preHandler: perEmailRateLimiter(instance, OTHER_NAMESPACE, EMAIL_LIMIT) },
      async () => ({ ok: true }),
    );
    instance.post(
      '/tight-ip',
      {
        config: { rateLimit: { max: 1, timeWindow: TIME_WINDOW } },
        preHandler: perEmailRateLimiter(instance, 'tight-ip-email', { max: 100, timeWindow: TIME_WINDOW }),
      },
      async () => ({ ok: true }),
    );
  };

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const post = (url, email, ip) => hit(app, { url, method: 'POST', ip, payload: { email } });

  it('returns an empty preHandler list when the rate-limit plugin is not registered', async () => {
    const bare = Fastify();
    await bare.ready();

    expect(perEmailRateLimiter(bare, EMAIL_NAMESPACE, EMAIL_LIMIT)).toEqual([]);
    await bare.close();
  });

  it('serves a route without the plugin registered', async () => {
    app = await buildApp({ withRateLimit: false, registerRoutes });

    const statuses = [];
    for (let i = 0; i < EMAIL_MAX + 2; i += 1) {
      statuses.push((await post('/login', 'a@example.com', IP_A)).statusCode);
    }

    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  it('counts the same email across different IPs, ignoring case and whitespace', async () => {
    app = await buildApp({ registerRoutes });
    await post('/login', 'user@example.com', IP_A);
    await post('/login', '  USER@Example.com ', IP_B);

    const third = await post('/login', 'User@example.com', IP_C);

    expect(third.statusCode).toBe(429);
  });

  it('responds with exactly the unified error contract and a retry-after header', async () => {
    app = await buildApp({ registerRoutes });
    await post('/login', 'user@example.com', IP_A);
    await post('/login', 'user@example.com', IP_B);

    const response = await post('/login', 'user@example.com', IP_C);
    const body = response.json();

    expect(response.statusCode).toBe(429);
    expect(Object.keys(body).sort()).toEqual(['details', 'error', 'message', 'messageCode']);
    expect(body.error).toBe(TOO_MANY_REQUESTS);
    expect(body.messageCode).toBe(RATE_LIMIT_MESSAGE_CODE);
    expect(typeof body.message).toBe('string');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(response.headers['retry-after'])).toBe(body.details.retryAfterSeconds);
  });

  it('does not share a counter between different emails', async () => {
    app = await buildApp({ registerRoutes });
    await post('/login', 'one@example.com', IP_A);
    await post('/login', 'one@example.com', IP_A);

    const other = await post('/login', 'two@example.com', IP_A);

    expect(other.statusCode).toBe(200);
  });

  it('does not share a counter between namespaces', async () => {
    app = await buildApp({ registerRoutes });
    await post('/login', 'user@example.com', IP_A);
    await post('/login', 'user@example.com', IP_A);

    const otherNamespace = await post('/forgot', 'user@example.com', IP_A);

    expect(otherNamespace.statusCode).toBe(200);
  });

  it('applies the per-IP limit even when the email limit is high', async () => {
    app = await buildApp({ registerRoutes });
    await post('/tight-ip', 'one@example.com', IP_A);

    const sameIpNewEmail = await post('/tight-ip', 'two@example.com', IP_A);
    const otherIp = await post('/tight-ip', 'three@example.com', IP_B);

    expect(sameIpNewEmail.statusCode).toBe(429);
    expect(otherIp.statusCode).toBe(200);
  });

  it('applies the per-email limit even when the IP limit is high', async () => {
    app = await buildApp({ registerRoutes });

    const statuses = [];
    for (const ip of [IP_A, IP_B, IP_C]) {
      statuses.push((await post('/login', 'user@example.com', ip)).statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });
});

import fastifyRateLimit from '@fastify/rate-limit';

import { globalRateLimitKey } from './rate-limit-key.js';

// Reduces a rate-limit key to its non-identifying kind (user, ip or a route namespace).
function rateLimitKeyKind(key) {
  return String(key).split(':')[0];
}

// Logs a throttled request with the route and key kind only, never the identity itself.
function logRateLimitExceeded(request, key) {
  request.log.warn({ url: request.routeOptions?.url ?? request.url, keyKind: rateLimitKeyKind(key) }, 'rate limit exceeded');
}

// Registers the single app-wide rate limiter: per user when authenticated, per normalized IP otherwise.
export async function registerRateLimit(fastify, { global, globalPerUser }) {
  await fastify.register(fastifyRateLimit, {
    timeWindow: global.timeWindow,
    max: (request) => (request.user ? globalPerUser.max : global.max),
    keyGenerator: globalRateLimitKey,
    enableDraftSpec: true,
    onExceeded: logRateLimitExceeded,
  });
}

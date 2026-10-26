import { AppError } from '../errors/app-error.js';

// Normalizes the body email so casing and whitespace cannot split one account's counter.
function bodyEmailKey(namespace, request) {
  return `${namespace}:${String(request.body?.email ?? '').trim().toLowerCase()}`;
}

// Builds preHandlers that throttle a public route per body email on top of its per-IP limit (empty when the plugin is off).
export function perEmailRateLimiter(fastify, namespace, limitConfig) {
  if (!fastify.hasDecorator('createRateLimit')) return [];
  // why: createRateLimit, not a second route-level limiter (the plugin runs once per request); a preHandler because the key comes from the validated body.
  const checkLimit = fastify.createRateLimit({
    ...limitConfig,
    keyGenerator: (request) => bodyEmailKey(namespace, request),
  });
  return [
    async (request, reply) => {
      const limit = await checkLimit(request);
      if (!limit.isExceeded) return;
      reply.header('retry-after', limit.ttlInSeconds);
      throw new AppError({
        httpStatus: 429,
        error: 'TOO_MANY_REQUESTS',
        messageCode: 'request.rateLimitExceeded',
        message: 'Too many requests. Try again later.',
        details: { retryAfterSeconds: limit.ttlInSeconds },
      });
    },
  ];
}

import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import { conditionalRateLimiter } from '../../src/helpers/per-email-rate-limiter.js';

const LIMIT_CONFIG = { max: 5, timeWindow: '1 minute' };
const RETRY_AFTER_SECONDS = 42;
// Constant key generator for the limiter under test.
function keyGenerator() {
  return 'key';
}

// Builds a fake fastify exposing createRateLimit with a controllable verdict.
function buildFastify(limitResult) {
  const checkLimit = vi.fn().mockResolvedValue(limitResult);
  const createRateLimit = vi.fn().mockReturnValue(checkLimit);
  return { fastify: { hasDecorator: (name) => name === 'createRateLimit', createRateLimit }, createRateLimit, checkLimit };
}

describe('conditionalRateLimiter', () => {
  it('should return no preHandlers when fastify lacks createRateLimit', () => {
    const fastify = { hasDecorator: () => false };

    expect(conditionalRateLimiter(fastify, { limitConfig: LIMIT_CONFIG, keyGenerator })).toEqual([]);
  });

  it('should build the limiter with the limit config and the key generator', () => {
    const { fastify, createRateLimit } = buildFastify({ isExceeded: false });

    conditionalRateLimiter(fastify, { limitConfig: LIMIT_CONFIG, keyGenerator });

    expect(createRateLimit).toHaveBeenCalledWith({ ...LIMIT_CONFIG, keyGenerator });
  });

  it('should skip the check when appliesTo returns false', async () => {
    const { fastify, checkLimit } = buildFastify({ isExceeded: true, ttlInSeconds: RETRY_AFTER_SECONDS });
    const [handler] = conditionalRateLimiter(fastify, { limitConfig: LIMIT_CONFIG, keyGenerator, appliesTo: () => false });

    await expect(handler({}, { header: vi.fn() })).resolves.toBeUndefined();
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it('should pass when the limiter is not exceeded', async () => {
    const { fastify } = buildFastify({ isExceeded: false });
    const reply = { header: vi.fn() };
    const [handler] = conditionalRateLimiter(fastify, { limitConfig: LIMIT_CONFIG, keyGenerator });

    await expect(handler({}, reply)).resolves.toBeUndefined();
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('should throw AppError 429 TOO_MANY_REQUESTS and set retry-after when the limiter is exceeded', async () => {
    const { fastify } = buildFastify({ isExceeded: true, ttlInSeconds: RETRY_AFTER_SECONDS });
    const reply = { header: vi.fn() };
    const [handler] = conditionalRateLimiter(fastify, { limitConfig: LIMIT_CONFIG, keyGenerator });

    const error = await handler({}, reply).catch((caught) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      httpStatus: 429,
      error: 'TOO_MANY_REQUESTS',
      messageCode: 'request.rateLimitExceeded',
      details: { retryAfterSeconds: RETRY_AFTER_SECONDS },
    });
    expect(reply.header).toHaveBeenCalledWith('retry-after', RETRY_AFTER_SECONDS);
  });
});

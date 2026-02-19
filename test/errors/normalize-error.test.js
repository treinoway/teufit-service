import { describe, expect, it } from 'vitest';
import {
  AppError,
  buildErrorPayload,
  normalizeError,
  normalizeErrorResponsePayload,
} from '../../src/errors/index.js';

describe('normalize-error', () => {
  it('returns AppError instances unchanged', () => {
    const appError = new AppError({
      httpStatus: 409,
      error: 'CONFLICT',
      messageCode: 'resource.conflict',
      message: 'Conflict',
    });

    const normalized = normalizeError(appError);

    expect(normalized).toBe(appError);
  });

  it('maps Fastify validation errors to VALIDATION_ERROR payload', () => {
    const fastifyValidationError = {
      validation: [
        {
          instancePath: '/firstName',
          keyword: 'minLength',
          message: 'must NOT have fewer than 1 characters',
          params: {},
        },
      ],
    };

    const normalized = normalizeError(fastifyValidationError);
    const payload = buildErrorPayload(normalized);

    expect(normalized.httpStatus).toBe(400);
    expect(payload).toMatchObject({
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Validation failed',
    });
    expect(payload.details).toEqual([
      {
        field: 'firstName',
        validations: ['minLength'],
        messageCode: 'validation.firstName.minLength',
        message: 'must NOT have fewer than 1 characters',
      },
    ]);
  });

  it('maps legacy errors keeping code and status code', () => {
    const legacyError = new Error('Missing Authorization header');
    legacyError.code = 'AUTH_REQUIRED';
    legacyError.statusCode = 401;

    const normalized = normalizeError(legacyError);
    const payload = buildErrorPayload(normalized);

    expect(normalized.httpStatus).toBe(401);
    expect(payload).toMatchObject({
      error: 'AUTH_REQUIRED',
      messageCode: 'legacy.AUTH_REQUIRED',
      message: 'Missing Authorization header',
    });
  });

  it('hides implementation messages in 5xx legacy errors', () => {
    const legacyError = new Error('database unavailable');
    legacyError.statusCode = 500;

    const normalized = normalizeError(legacyError);
    const payload = buildErrorPayload(normalized);

    expect(normalized.httpStatus).toBe(500);
    expect(payload).toMatchObject({
      error: 'INTERNAL_SERVER_ERROR',
      messageCode: 'internal.serverError',
      message: 'Internal server error',
    });
  });

  it('adds missing messageCode to legacy response payloads', () => {
    const payload = normalizeErrorResponsePayload(
      { error: 'Authentication required' },
      401,
    );

    expect(payload).toMatchObject({
      error: 'Authentication required',
      messageCode: 'auth.unauthorized',
      message: 'Authentication required',
    });
  });
});

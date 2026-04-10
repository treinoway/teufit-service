import { AppError, ConflictAppError, NotFoundAppError, ValidationAppError } from './app-error.js';
import { translate, translateTemplate } from '../i18n/index.js';

function isFastifyValidationError(error) {
  return Boolean(error?.validation && Array.isArray(error.validation));
}

function mapHttpStatusToCategory(statusCode) {
  if (statusCode === 400) return 'BAD_REQUEST';
  if (statusCode === 401) return 'UNAUTHORIZED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 429) return 'TOO_MANY_REQUESTS';
  return 'INTERNAL_SERVER_ERROR';
}

function mapHttpStatusToMessageCode(statusCode) {
  if (statusCode === 400) return 'request.badRequest';
  if (statusCode === 401) return 'auth.unauthorized';
  if (statusCode === 403) return 'auth.forbidden';
  if (statusCode === 404) return 'resource.notFound';
  if (statusCode === 409) return 'resource.conflict';
  if (statusCode === 429) return 'request.rateLimitExceeded';
  return 'internal.serverError';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFieldName(instancePath, validationError) {
  const missingProperty = validationError?.params?.missingProperty;
  if (missingProperty) return missingProperty;

  if (!instancePath) return 'body';
  return instancePath.replace(/^\//, '').replace(/\//g, '.');
}

function buildValidationVars(field, keyword, params = {}) {
  // AJV uses `limit` for minLength/maxLength/minimum/maximum, and `allowedValues` for enum.
  // We normalize these into {field}, {min}, {max}, {allowedValues} placeholders.
  const vars = { field, ...params };

  if (keyword === 'minLength' || keyword === 'minimum') {
    vars.min = params.limit;
  }
  if (keyword === 'maxLength' || keyword === 'maximum') {
    vars.max = params.limit;
  }
  if (keyword === 'enum' && Array.isArray(params.allowedValues)) {
    vars.allowedValues = params.allowedValues;
  }

  return vars;
}

function normalizeValidationDetails(validationErrors = [], language) {
  return validationErrors.map((validationError) => {
    const field = normalizeFieldName(validationError.instancePath, validationError);
    const keyword = validationError.keyword || 'invalid';
    // Only translate when a language is explicitly provided; otherwise keep the raw AJV message
    const message = language
      ? translateTemplate('validation', keyword, language, buildValidationVars(field, keyword, validationError.params ?? {}))
      : validationError.message;
    return {
      field,
      validations: [keyword],
      messageCode: `validation.${field}.${keyword}`,
      message,
    };
  });
}

function normalizeLegacyError(error) {
  const httpStatus =
    Number.isInteger(error?.httpStatus) ? error.httpStatus
      : Number.isInteger(error?.statusCode) ? error.statusCode
        : 500;

  const isClientError = httpStatus >= 400 && httpStatus < 500;
  const legacyCode = typeof error?.code === 'string' ? error.code : undefined;

  return new AppError({
    httpStatus,
    error: legacyCode || mapHttpStatusToCategory(httpStatus),
    messageCode: legacyCode ? `legacy.${legacyCode}` : mapHttpStatusToMessageCode(httpStatus),
    message:
      isClientError && error?.message
        ? error.message
        : isClientError
          ? 'Request failed'
          : 'Internal server error',
    details: error?.details,
    cause: error,
  });
}

function normalizePrismaError(error) {
  if (!error?.code || typeof error.code !== 'string' || !error.code.startsWith('P')) {
    return null;
  }

  if (error.code === 'P2002') {
    return new ConflictAppError({
      message: 'A unique constraint would be violated',
      messageCode: 'database.uniqueConstraint',
      details: {
        code: error.code,
        target: error?.meta?.target,
      },
    });
  }

  if (error.code === 'P2025') {
    return new NotFoundAppError({
      message: 'Requested record was not found',
      messageCode: 'database.recordNotFound',
      details: {
        code: error.code,
      },
    });
  }

  return null;
}

export function normalizeError(error, language) {
  if (error instanceof AppError) return error;

  if (isFastifyValidationError(error)) {
    return new ValidationAppError({
      details: normalizeValidationDetails(error.validation, language),
    });
  }

  const prismaError = normalizePrismaError(error);
  if (prismaError) return prismaError;

  return normalizeLegacyError(error);
}

export function buildErrorPayload(appError, { language, includeStatus = false } = {}) {
  // Only translate when a language is explicitly provided (e.g. from request.language).
  // When called without a language (e.g. in tests or legacy call sites), the AppError's
  // original message is used as-is — this preserves backward compatibility.
  const message = language
    ? translate('errors', appError.messageCode, language, { fallbackValue: appError.message })
    : appError.message;

  const payload = {
    error: appError.error,
    messageCode: appError.messageCode,
    message,
  };

  if (appError.details !== undefined) {
    payload.details = appError.details;
  }

  if (includeStatus) {
    payload.status = appError.httpStatus;
  }

  return payload;
}

export function normalizeErrorResponsePayload(payload, statusCode) {
  if (!isPlainObject(payload) || statusCode < 400) {
    return payload;
  }

  if (payload.messageCode) {
    return payload;
  }

  const normalizedPayload = {
    ...payload,
    messageCode: mapHttpStatusToMessageCode(statusCode),
  };

  if (normalizedPayload.error === undefined) {
    normalizedPayload.error = mapHttpStatusToCategory(statusCode);
  }

  if (statusCode >= 500) {
    normalizedPayload.message = 'Internal server error';
    return normalizedPayload;
  }

  if (normalizedPayload.message === undefined) {
    normalizedPayload.message =
      typeof normalizedPayload.error === 'string'
        ? normalizedPayload.error
        : 'Request failed';
  }

  return normalizedPayload;
}

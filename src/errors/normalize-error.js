import { AppError, ConflictAppError, NotFoundAppError, ValidationAppError } from './app-error.js';

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

function normalizeValidationDetails(validationErrors = []) {
  return validationErrors.map((validationError) => {
    const field = normalizeFieldName(validationError.instancePath, validationError);
    const keyword = validationError.keyword || 'invalid';
    return {
      field,
      validations: [keyword],
      messageCode: `validation.${field}.${keyword}`,
      message: validationError.message,
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

export function normalizeError(error) {
  if (error instanceof AppError) return error;

  if (isFastifyValidationError(error)) {
    return new ValidationAppError({
      details: normalizeValidationDetails(error.validation),
    });
  }

  const prismaError = normalizePrismaError(error);
  if (prismaError) return prismaError;

  return normalizeLegacyError(error);
}

export function buildErrorPayload(appError, includeStatus = false) {
  const payload = {
    error: appError.error,
    messageCode: appError.messageCode,
    message: appError.message,
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

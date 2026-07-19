const DEFAULT_ERROR = 'INTERNAL_SERVER_ERROR';
const DEFAULT_MESSAGE_CODE = 'internal.serverError';

export class AppError extends Error {
  constructor({
    httpStatus = 500,
    error = DEFAULT_ERROR,
    messageCode = DEFAULT_MESSAGE_CODE,
    message = 'Internal server error',
    details,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.error = error;
    this.messageCode = messageCode;
    this.details = details;

    // Backward compatibility during incremental migration.
    this.statusCode = httpStatus;
    this.code = error;
  }
}

export class ValidationAppError extends AppError {
  constructor({ message = 'Validation failed', details, messageCode = 'validation.failed' } = {}) {
    super({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode,
      message,
      details,
    });
    this.name = 'ValidationAppError';
  }
}

export class UnauthorizedAppError extends AppError {
  constructor({ message = 'Authentication required', messageCode = 'auth.unauthorized', error = 'UNAUTHORIZED', details } = {}) {
    super({
      httpStatus: 401,
      error,
      messageCode,
      message,
      details,
    });
    this.name = 'UnauthorizedAppError';
  }
}

export class ForbiddenAppError extends AppError {
  constructor({ message = 'Forbidden', messageCode = 'auth.forbidden', error = 'FORBIDDEN', details } = {}) {
    super({
      httpStatus: 403,
      error,
      messageCode,
      message,
      details,
    });
    this.name = 'ForbiddenAppError';
  }
}

export class NotFoundAppError extends AppError {
  constructor({ message = 'Resource not found', messageCode = 'resource.notFound', error = 'NOT_FOUND', details } = {}) {
    super({
      httpStatus: 404,
      error,
      messageCode,
      message,
      details,
    });
    this.name = 'NotFoundAppError';
  }
}

export class ConflictAppError extends AppError {
  constructor({ message = 'Conflict', messageCode = 'resource.conflict', error = 'CONFLICT', details } = {}) {
    super({
      httpStatus: 409,
      error,
      messageCode,
      message,
      details,
    });
    this.name = 'ConflictAppError';
  }
}

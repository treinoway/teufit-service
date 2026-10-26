// Error codes thrown by address-service when a postal code lookup fails.
export const PostalCodeErrorCode = Object.freeze({
  REQUIRED: 'POSTAL_CODE_REQUIRED',
  INVALID_FORMAT: 'INVALID_POSTAL_CODE_FORMAT',
  NOT_FOUND: 'POSTAL_CODE_NOT_FOUND',
  API_ERROR: 'POSTAL_CODE_API_ERROR',
});

export const POSTAL_CODE_ERROR_CODES = new Set(Object.values(PostalCodeErrorCode));

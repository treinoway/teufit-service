export const errorDetailsSchema = {
  anyOf: [
    { type: 'object', additionalProperties: true },
    {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  ],
};

export const errorResponseSchema = {
  type: 'object',
  required: ['error', 'messageCode', 'message'],
  properties: {
    error: { type: 'string' },
    messageCode: { type: 'string' },
    message: { type: 'string' },
    details: errorDetailsSchema,
  },
  additionalProperties: true,
};

export const validationErrorResponseSchema = {
  type: 'object',
  required: ['error', 'messageCode', 'message', 'details'],
  properties: {
    error: { type: 'string', enum: ['VALIDATION_ERROR'] },
    messageCode: { type: 'string', enum: ['validation.failed'] },
    message: { type: 'string' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          validations: { type: 'array', items: { type: 'string' } },
          messageCode: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

export const badRequestErrorResponseSchema = {
  oneOf: [validationErrorResponseSchema, errorResponseSchema],
};

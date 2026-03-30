import {
  badRequestErrorResponseSchema,
  errorResponseSchema,
} from './error-response.schema.js';

const importedStudentItemSchema = {
  type: 'object',
  properties: {
    fullName: { type: 'string', nullable: true },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    plan: { type: 'string', nullable: true },
    status: { type: 'string', nullable: true },
    expirationDate: { type: 'string', nullable: true },
    daysRemaining: { type: 'number', nullable: true },
    anamnesis: { type: 'string', nullable: true },
    photos: { type: 'string', nullable: true },
    training: { type: 'string', nullable: true },
    diet: { type: 'string', nullable: true },
    cardio: { type: 'string', nullable: true },
    duplicateEmail: { type: 'boolean' },
  },
};

const importSummarySchema = {
  type: 'object',
  required: ['total', 'withEmail', 'withoutEmail', 'duplicateEmails'],
  properties: {
    total: { type: 'integer', description: 'Total rows in the export' },
    withEmail: {
      type: 'integer',
      description: 'Rows that have a valid email and are returned as students',
    },
    withoutEmail: {
      type: 'integer',
      description: 'Rows without an email (excluded from the student list)',
    },
    duplicateEmails: {
      type: 'integer',
      description: 'Number of distinct email addresses that appear more than once',
    },
  },
};

export const importPrimeCoachingPreviewSchema = {
  tags: ['import'],
  summary: 'Preview student import from PrimeCoaching',
  description:
    'Accepts a PrimeCoaching active customers XLSX export uploaded as multipart/form-data, parses it, and returns the student list as a preview. Nothing is saved to the database.',
  consumes: ['multipart/form-data'],
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['students', 'summary'],
      properties: {
        students: {
          type: 'array',
          items: importedStudentItemSchema,
        },
        summary: importSummarySchema,
      },
    },
    400: badRequestErrorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

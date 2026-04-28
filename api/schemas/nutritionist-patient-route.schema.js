import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const patientSchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    birthDate: { type: 'string', nullable: true },
    gender: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

const patientLinkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    nutritionistId: { type: 'string', format: 'uuid' },
    patientId: { type: 'string', format: 'uuid' },
    status: { type: 'string' },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    patient: patientSchema,
  },
};

export const linkPatientSchema = {
  tags: ['Nutritionist - Patients'],
  summary: 'Link a patient to a nutritionist',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email', description: 'Email of the patient to link' },
      notes: { type: 'string', nullable: true },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      description: 'Patient linked successfully',
      ...patientLinkSchema,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listPatientsSchema = {
  tags: ['Nutritionist - Patients'],
  summary: 'List patients linked to a nutritionist',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: patientLinkSchema,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const unlinkPatientSchema = {
  tags: ['Nutritionist - Patients'],
  summary: 'Unlink a patient from a nutritionist',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['patientId'],
    properties: {
      patientId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        deletedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const upsertMetabolicProfileSchema = {
  tags: ['Nutritionist - Patients'],
  summary: 'Create or update metabolic profile for a patient',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['patientId'],
    properties: {
      patientId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      weightKg: { type: 'number', minimum: 0 },
      heightCm: { type: 'number', minimum: 0 },
      leanBodyMassKg: { type: 'number', minimum: 0 },
      tmbFormula: {
        type: 'string',
        enum: ['harris_benedict', 'mifflin_st_jeor', 'fao_who', 'cunningham'],
      },
      tmbKcal: { type: 'number', minimum: 0 },
      activityLevel: {
        type: 'string',
        enum: ['sedentario', 'levemente_ativo', 'moderadamente_ativo', 'muito_ativo', 'extremamente_ativo'],
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      description: 'Upserted metabolic profile',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        patientId: { type: 'string', format: 'uuid' },
        nutritionistId: { type: 'string', format: 'uuid' },
        weightKg: { type: 'number', nullable: true },
        heightCm: { type: 'number', nullable: true },
        leanBodyMassKg: { type: 'number', nullable: true },
        tmbFormula: { type: 'string', nullable: true },
        tmbKcal: { type: 'number', nullable: true },
        activityLevel: { type: 'string', nullable: true },
        palMultiplier: { type: 'number', nullable: true },
        getKcal: { type: 'number', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

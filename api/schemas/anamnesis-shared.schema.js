import {
  anamnesisCategoryValues,
  anamnesisQuestionTypeValues,
  anamnesisCreatableQuestionTypes,
} from '../../src/constants/anamnesis.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

// ─── Shared sub-schemas used by both anamnesis-route.schema.js and admin-anamnesis-route.schema.js

export const questionOptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    questionId: { type: 'string', format: 'uuid' },
    text: { type: 'string' },
    order: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const conditionSchema = {
  anyOf: [
    {
      type: 'object',
      description: 'Condition object for conditional question visibility',
      additionalProperties: true,
    },
    { type: 'null' },
  ],
};

export const questionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sectionId: { type: 'string', format: 'uuid' },
    text: { type: 'string' },
    ...i18nField('type', 'anamnesisQuestionType'),
    required: { type: 'boolean' },
    order: { type: 'integer' },
    config: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    parentQuestionId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    condition: conditionSchema,
    options: { type: 'array', items: questionOptionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const sectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    order: { type: 'integer' },
    questions: { type: 'array', items: questionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const anamnesisSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid', nullable: true },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('category', 'anamnesisCategory', { nullable: true }),
    isGeneral: { type: 'boolean' },
    version: { type: 'integer' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    sections: { type: 'array', items: sectionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const anamnesisListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid', nullable: true },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('category', 'anamnesisCategory', { nullable: true }),
    isGeneral: { type: 'boolean' },
    version: { type: 'integer' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    questionCount: {
      type: 'integer',
      description: 'Number of non-deleted questions across the non-deleted sections (conditional ones included).',
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          order: { type: 'integer' },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// Request `category` (catalog). null = uncategorized.
export const anamnesisCategoryBodySchema = {
  type: 'string',
  enum: [...anamnesisCategoryValues, null],
  nullable: true,
  description: `Catalog category: ${anamnesisCategoryValues.join(', ')} (null = uncategorized).`,
};

export const deletedAtResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    deletedAt: { type: 'string', format: 'date-time' },
  },
};

export const questionOptionBodySchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1 },
    order: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

// Request `type`. The enum is intentionally the FULL list (legacy `matrix` included) so that a retired
// type reaches the service and is rejected with the domain error 400 INVALID_QUESTION_TYPE (instead of
// a generic VALIDATION_ERROR), while a legacy question can still be edited without changing its type.
export const questionTypeBodySchema = {
  type: 'string',
  enum: anamnesisQuestionTypeValues,
  description:
    `Accepted for new content: ${anamnesisCreatableQuestionTypes.join(', ')}. "matrix" is retired: creating a ` +
    'question with it, or changing a question to it, returns 400 INVALID_QUESTION_TYPE.',
};

export const questionBodySchema = {
  type: 'object',
  required: ['text', 'type'],
  properties: {
    text: { type: 'string', minLength: 1 },
    type: questionTypeBodySchema,
    required: { type: 'boolean' },
    order: { type: 'integer', minimum: 0 },
    config: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    options: { type: 'array', items: questionOptionBodySchema },
    parentQuestionId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    condition: conditionSchema,
  },
  additionalProperties: false,
};

export const sectionBodySchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', nullable: true },
    order: { type: 'integer', minimum: 0 },
    questions: { type: 'array', items: questionBodySchema },
  },
  additionalProperties: false,
};

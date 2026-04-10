import { anamnesisQuestionTypeValues } from '../../src/constants/anamnesis.js';
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

export const questionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sectionId: { type: 'string', format: 'uuid' },
    text: { type: 'string' },
    ...i18nField('type', 'anamnesisQuestionType'),
    required: { type: 'boolean' },
    order: { type: 'integer' },
    config: { anyOf: [{ type: 'object' }, { type: 'null' }] },
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
    isGeneral: { type: 'boolean' },
    version: { type: 'integer' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
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

export const questionBodySchema = {
  type: 'object',
  required: ['text', 'type'],
  properties: {
    text: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: anamnesisQuestionTypeValues },
    required: { type: 'boolean' },
    order: { type: 'integer', minimum: 0 },
    config: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    options: { type: 'array', items: questionOptionBodySchema },
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

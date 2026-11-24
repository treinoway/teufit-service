/**
 * Schemas of the student consistency routes (F3). The response schemas declare only what a participant may see:
 * peer rows carry no id, e-mail, phone or pillars, and Fastify drops anything else the service returns (APP-40, APP-41).
 */

import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { challengeVisibilityValues } from '../../src/constants/challenge.js';
import {
  AppearAs,
  Faixa,
  StudentOverviewState,
  WeekStatus,
  WeekStripStatus,
  appearAsChoiceValues,
  pillarValues,
} from '../../src/constants/consistency-ranking.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

const faixaField = { type: 'string', enum: Object.values(Faixa), nullable: true };

const privacySchema = {
  type: 'object',
  description: 'How the student appears to the other participants, one choice for every championship',
  properties: {
    appearAs: { type: 'string', enum: Object.values(AppearAs), description: '"pending" until the student answers the current term version' },
    termVersion: { type: 'string', description: 'Current version of the privacy term' },
    acceptedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const pillarRowSchema = {
  type: 'object',
  properties: {
    pillar: { type: 'string', enum: pillarValues },
    done: { type: 'integer' },
    expected: { type: 'integer' },
    missing: { type: 'integer' },
    complete: { type: 'boolean' },
  },
};

// The student's own live week (only the active, weighted pillars with a target)
const weekBlockSchema = {
  type: 'object',
  nullable: true,
  properties: {
    score: { type: 'number', nullable: true, description: 'Partial score of the week; null without a target' },
    status: { type: 'string', enum: Object.values(WeekStatus) },
    paused: { type: 'boolean' },
    closesAt: { type: 'string', format: 'date-time' },
    pillars: { type: 'array', items: pillarRowSchema },
    missingPhrase: { type: 'string', nullable: true, description: '"Faltam ..." sentence, the complete-week sentence, or null without a target' },
  },
};

const highlightSchema = {
  type: 'object',
  nullable: true,
  description: 'Running weekly championship that ends first; null without one. Figures follow the championship visibility',
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    visibility: { type: 'string', enum: challengeVisibilityValues, description: 'Effective visibility: "off" for a minor' },
    position: { type: 'integer', nullable: true },
    total: { type: 'integer', nullable: true },
    faixa: faixaField,
    average: { type: 'number', nullable: true },
  },
};

// A participant as another participant sees them: no id, e-mail, phone or pillars (APP-40, APP-41)
const peerRowProperties = {
  key: { type: 'string', description: 'Opaque key, stable only inside this response' },
  displayName: { type: 'string', description: 'First name and initial of the last name, or "Aluno do time"' },
  initials: { type: 'string' },
  avatarUrl: { type: 'string', nullable: true },
  position: { type: 'integer', nullable: true },
  average: { type: 'number', nullable: true },
  faixa: faixaField,
  streak: { type: 'integer' },
  isMe: { type: 'boolean' },
};

const peerRowSchema = { type: 'object', properties: peerRowProperties };

const podiumRowSchema = {
  type: 'object',
  properties: { ...peerRowProperties, shared: { type: 'boolean', description: 'The place is shared ("Nº dividido")' } },
};

const enteringRowSchema = {
  type: 'object',
  properties: {
    ...peerRowProperties,
    validWeeks: { type: 'integer' },
    required: { type: 'integer', nullable: true },
    weeksMissing: { type: 'integer' },
  },
};

const boardSchema = {
  type: 'object',
  nullable: true,
  description: 'Classification of the championship; null unless the visibility is "full"',
  properties: {
    podium: { type: 'array', nullable: true, items: podiumRowSchema, description: 'Null when Clube 100% replaces it' },
    club100: {
      type: 'object',
      nullable: true,
      properties: { total: { type: 'integer' }, members: { type: 'array', items: peerRowSchema } },
    },
    tieSentence: { type: 'string', nullable: true },
    neighbors: { type: 'array', items: peerRowSchema, description: 'The student with up to 2 above and 2 below' },
    entering: { type: 'array', items: enteringRowSchema },
    total: { type: 'integer', description: 'Classified participants' },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    totalPages: { type: 'integer' },
    items: { type: 'array', items: peerRowSchema, description: 'One page of the full classified list' },
  },
};

const weekStripItemSchema = {
  type: 'object',
  properties: {
    week: { type: 'integer' },
    weekStart: { type: 'string', format: 'date' },
    status: { type: 'string', enum: Object.values(WeekStripStatus) },
    score: { type: 'number', nullable: true },
  },
};

const effectiveWeightSchema = {
  type: 'object',
  properties: {
    pillar: { type: 'string', enum: pillarValues },
    weight: { type: 'integer' },
    percent: { type: 'number', description: 'Share of the active weights, one decimal' },
  },
};

// "Minha constância": the student's own figures in the championship, hidden as the visibility says
const meSchema = {
  type: 'object',
  nullable: true,
  description: 'Null for a scheduled championship',
  properties: {
    appearsAs: { type: 'string', description: 'Name the others see for the student' },
    position: { type: 'integer', nullable: true },
    total: { type: 'integer', nullable: true },
    faixa: faixaField,
    average: { type: 'number', nullable: true },
    weeks100: {
      type: 'object',
      nullable: true,
      properties: { done: { type: 'integer' }, of: { type: 'integer' } },
      description: 'Weeks at 100% out of the closed weeks of the championship',
    },
    streak: { type: 'integer', nullable: true },
    entering: {
      type: 'object',
      nullable: true,
      properties: { validWeeks: { type: 'integer' }, required: { type: 'integer', nullable: true }, weeksMissing: { type: 'integer' } },
    },
    firstPlaceShared: { type: 'integer', nullable: true, description: 'Others sharing the 1st place with the student' },
    week: weekBlockSchema,
    weekStrip: { type: 'array', items: weekStripItemSchema },
    effectiveWeights: { type: 'array', items: effectiveWeightSchema },
  },
};

const boardChallengeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('status', 'challengeStatus'),
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' },
    weeks: { type: 'integer' },
    currentWeek: { type: 'integer', nullable: true },
    participantCount: { type: 'integer' },
    closedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const getMyConsistencyOverviewSchema = {
  tags: ['consistency-ranking'],
  summary: 'Student overview: live week, highlighted championship, other running championships and the privacy choice',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: Object.values(StudentOverviewState), description: '"no_trainer" without an active trainer link' },
        week: weekBlockSchema,
        highlight: highlightSchema,
        othersCount: { type: 'integer', description: 'Other running weekly championships ("+N campeonatos")' },
        privacy: privacySchema,
      },
    },
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const putMyConsistencyPrivacySchema = {
  tags: ['consistency-ranking'],
  summary: 'Store how the student appears to the other participants of every championship',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['appearAs', 'termVersion'],
    additionalProperties: false,
    properties: {
      appearAs: { type: 'string', enum: appearAsChoiceValues },
      termVersion: { type: 'string', description: 'Must be the current term version' },
    },
  },
  response: {
    200: privacySchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyChallengeConsistencySchema = {
  tags: ['challenges'],
  summary: 'Consistency classification of a weekly championship as a participant sees it, anonymized and with the visibility applied',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1, description: 'Page of the full classified list, 20 rows each' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        challenge: boardChallengeSchema,
        visibility: { type: 'string', enum: challengeVisibilityValues, description: 'Effective visibility: "off" for a minor' },
        closesAt: { type: 'string', format: 'date-time', nullable: true, description: 'Close instant of the running week' },
        me: meSchema,
        board: boardSchema,
        privacy: privacySchema,
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

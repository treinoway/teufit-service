import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  MILESTONE_TEMPLATE_SLOTS,
  OPEN_ANSWER_MAX_LENGTH,
  RESPONSE_WINDOW_DAYS,
  RESPONSE_WINDOW_FIELD,
  RESPONSE_WINDOW_MAX_DAYS,
  RESPONSE_WINDOW_MIN_DAYS,
  STUDENT_FEEDBACK_CONFIG_FIELDS,
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  studentFeedbackInboxFilterValues,
  studentFeedbackMilestoneValues,
  studentFeedbackPillarValues,
  studentFeedbackQuestionConditionValues,
  studentFeedbackQuestionTypeValues,
} from '../../src/constants/student-feedback.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

const MAX_ANSWERS_PER_REQUEST = 100;
const STUDENT_TAG = 'student-feedback';
const TRAINER_TAG = 'trainer-student-feedback';
const TEMPLATE_TAG = 'trainer-student-feedback-template';
const security = [{ bearerAuth: [] }];

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      description: 'Bearer access token (e.g., "Bearer <token>")',
    },
  },
};

const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { ...dateTime, nullable: true };
const indexSchema = { type: 'integer', nullable: true, description: 'Overall index 0-100; null until answered or when nothing was scored' };

// Error responses shared by every route, plus the extra status codes of the route
function errorResponses(...extraStatuses) {
  const statuses = [401, 403, 404, 500, ...extraStatuses];
  return Object.fromEntries(statuses.map((status) => [status, status === 400 ? badRequestErrorResponseSchema : errorResponseSchema]));
}

// Params schema with one required uuid
function uuidParams(name) {
  return { type: 'object', required: [name], properties: { [name]: { type: 'string', format: 'uuid' } } };
}

const personSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    avatarUrl: { type: 'string', nullable: true },
  },
};

const studentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    ...personSchema.properties,
  },
};

const headerProperties = {
  id: { type: 'string', format: 'uuid' },
  ...i18nField('milestone', 'studentFeedbackMilestone'),
  title: { type: 'string', description: 'Name of the questionnaire template' },
  trainer: personSchema,
  questionCount: { type: 'integer' },
  estimatedMinutes: { type: 'integer' },
  expiresAt: dateTime,
  daysLeft: { type: 'integer', description: 'Started days left to answer; 0 once expired' },
};

const questionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    order: { type: 'integer' },
    text: { type: 'string' },
    helpText: { type: 'string', nullable: true },
    ...i18nField('type', 'studentFeedbackQuestionType'),
    required: { type: 'boolean' },
    minLabel: { type: 'string', nullable: true, description: 'Label of the lowest value of a score question' },
    maxLabel: { type: 'string', nullable: true, description: 'Label of the highest value of a score question' },
  },
};

const answerSchema = {
  type: 'object',
  properties: {
    questionId: { type: 'string', format: 'uuid' },
    score: { type: 'integer', nullable: true, description: 'score: 0-10; stars: 1-5; null for open questions' },
    text: { type: 'string', nullable: true, description: 'Open questions only' },
  },
};

const answersBody = {
  type: 'object',
  required: ['answers'],
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      maxItems: MAX_ANSWERS_PER_REQUEST,
      items: {
        type: 'object',
        required: ['questionId'],
        additionalProperties: false,
        properties: {
          questionId: { type: 'string', format: 'uuid' },
          score: { type: 'number', nullable: true, description: 'Integer: 0-10 for score questions, 1-5 for stars; null clears the answer' },
          text: { type: 'string', nullable: true, maxLength: OPEN_ANSWER_MAX_LENGTH, description: 'Open questions; null or blank clears the answer' },
        },
      },
    },
  },
};

const requestSummaryProperties = {
  ...i18nField('milestone', 'studentFeedbackMilestone'),
  ...i18nField('status', 'studentFeedbackStatus'),
  sentAt: dateTime,
  expiresAt: dateTime,
  submittedAt: nullableDateTime,
  readAt: nullableDateTime,
  overallIndex: indexSchema,
  ...i18nField('band', 'studentFeedbackBand', { nullable: true }),
};

const configSwitchProperties = Object.fromEntries(STUDENT_FEEDBACK_CONFIG_FIELDS.filter((field) => field !== RESPONSE_WINDOW_FIELD).map((field) => [field, { type: 'boolean' }]));
const responseWindowBodyProperty = {
  type: 'integer',
  minimum: RESPONSE_WINDOW_MIN_DAYS,
  maximum: RESPONSE_WINDOW_MAX_DAYS,
  description: `Days a student has to answer a feedback sent from now on (default ${RESPONSE_WINDOW_DAYS}); requests already sent keep their deadline`,
};
const configBodyProperties = { ...configSwitchProperties, [RESPONSE_WINDOW_FIELD]: responseWindowBodyProperty };
const configResponseProperties = { ...configSwitchProperties, [RESPONSE_WINDOW_FIELD]: { type: 'integer', description: 'Days a student has to answer a feedback sent from now on' } };
const configResponseSchema = { type: 'object', properties: configResponseProperties };

export const getPendingFeedbackSchema = {
  tags: [STUDENT_TAG],
  summary: 'Get the pending feedback of the student',
  description: 'Most recent feedback the student can still answer, for the home card; `feedback` is null when there is none.',
  security,
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: { feedback: { type: 'object', nullable: true, properties: headerProperties } },
    },
    ...errorResponses(),
  },
};

export const getFeedbackSchema = {
  tags: [STUDENT_TAG],
  summary: 'Get one feedback of the student with its questions and saved answers',
  description: 'Questions that depend on a meal plan are present only when the student had one when the feedback was sent.',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  response: {
    200: {
      type: 'object',
      properties: {
        ...headerProperties,
        ...i18nField('status', 'studentFeedbackStatus'),
        questions: { type: 'array', items: questionSchema },
        answers: { type: 'array', items: answerSchema },
      },
    },
    ...errorResponses(400),
  },
};

export const saveDraftSchema = {
  tags: [STUDENT_TAG],
  summary: 'Save answers of a feedback as a draft',
  description:
    'Replaces the answer of each question sent and keeps the others. Fails with 400 STUDENT_FEEDBACK_INVALID_ANSWER, ' +
    '409 STUDENT_FEEDBACK_EXPIRED or 409 STUDENT_FEEDBACK_ALREADY_SUBMITTED.',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  body: answersBody,
  response: {
    200: { type: 'object', properties: { answers: { type: 'array', items: answerSchema } } },
    ...errorResponses(400, 409),
  },
};

export const submitFeedbackSchema = {
  tags: [STUDENT_TAG],
  summary: 'Submit a feedback',
  description:
    'The answers sent complete the saved draft. Fails with 400 STUDENT_FEEDBACK_REQUIRED_ANSWER_MISSING or STUDENT_FEEDBACK_INVALID_ANSWER, ' +
    '409 STUDENT_FEEDBACK_EXPIRED or 409 STUDENT_FEEDBACK_ALREADY_SUBMITTED.',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  body: answersBody,
  response: {
    200: {
      type: 'object',
      properties: { nextFeedbackAt: { ...nullableDateTime, description: 'When the next automatic feedback falls due; null when none is scheduled' } },
    },
    ...errorResponses(400, 409),
  },
};

export const listInboxSchema = {
  tags: [TRAINER_TAG],
  summary: 'List the student feedbacks of the trainer',
  description: 'Most recently sent first, capped by `limit`. The summary covers the whole inbox, whatever the filters and the limit.',
  security,
  headers: authHeaders,
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: studentFeedbackInboxFilterValues, description: 'unread = answered and not read; unanswered = expired' },
      milestone: { type: 'string', enum: studentFeedbackMilestoneValues },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: INBOX_MAX_LIMIT,
        default: INBOX_DEFAULT_LIMIT,
        description: 'Maximum number of items returned (the most recently sent ones)',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        summary: {
          type: 'object',
          properties: {
            responseRate30d: { type: 'integer', nullable: true, description: 'Share (0-100) answered among the feedbacks sent in the last 30 days' },
            averageIndex: { type: 'integer', nullable: true, description: 'Mean overall index of the answered feedbacks (the 1000 most recently sent ones)' },
            unansweredCount: { type: 'integer' },
            unreadCount: { type: 'integer' },
          },
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' }, student: studentSchema, ...requestSummaryProperties },
          },
        },
      },
    },
    ...errorResponses(400),
  },
};

export const countUnreadSchema = {
  tags: [TRAINER_TAG],
  summary: 'Count the answered student feedbacks the trainer has not read',
  security,
  headers: authHeaders,
  response: {
    200: { type: 'object', properties: { count: { type: 'integer' } } },
    ...errorResponses(),
  },
};

export const markAsReadSchema = {
  tags: [TRAINER_TAG],
  summary: 'Mark a student feedback as read',
  description: 'Keeps the first read date. A feedback that was not answered yet stays unread (`readAt` null).',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  response: {
    200: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, readAt: nullableDateTime } },
    ...errorResponses(400),
  },
};

const pillarAnswerSchema = {
  type: 'object',
  properties: {
    questionId: { type: 'string', format: 'uuid' },
    question: { type: 'string' },
    ...i18nField('type', 'studentFeedbackQuestionType'),
    value: { type: 'integer', description: 'Answer as the student gave it, before any inversion' },
    max: { type: 'integer', description: 'Maximum of the scale of the question type' },
    inverted: { type: 'boolean', description: 'Whether a higher answer lowers the pillar score' },
  },
};

const autoSendSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', description: 'Whether the trainer has automatic sending on' },
    next: {
      type: 'object',
      nullable: true,
      description: 'Next automatic feedback of this student; null when auto-send is off, nothing is left to send or the student is blocked on the plan',
      properties: { ...i18nField('milestone', 'studentFeedbackMilestone'), dueAt: dateTime },
    },
  },
};

export const getStudentHistorySchema = {
  tags: [TRAINER_TAG],
  summary: 'Get the feedback history of a student',
  description: 'Feedbacks this trainer sent to the student, oldest first, with pillar scores, bands, scored answers and open answers of the answered ones, plus the auto-send state and the next automatic milestone.',
  security,
  headers: authHeaders,
  params: uuidParams('studentId'),
  response: {
    200: {
      type: 'object',
      properties: {
        student: studentSchema,
        hasPending: { type: 'boolean' },
        autoSend: autoSendSchema,
        feedbacks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              ...requestSummaryProperties,
              pillars: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ...i18nField('pillar', 'studentFeedbackPillar'),
                    score: { type: 'integer' },
                    ...i18nField('band', 'studentFeedbackBand'),
                    answers: { type: 'array', description: 'Scored answers behind the pillar score, in question order', items: pillarAnswerSchema },
                  },
                },
              },
              openAnswers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    questionId: { type: 'string', format: 'uuid' },
                    question: { type: 'string' },
                    ...i18nField('pillar', 'studentFeedbackPillar'),
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    ...errorResponses(400),
  },
};

export const sendAdhocFeedbackSchema = {
  tags: [TRAINER_TAG],
  summary: 'Send an ad-hoc feedback to a student',
  description:
    'Works with auto-send off. The body is optional: without `templateId` the general template is sent. Fails with 409 STUDENT_FEEDBACK_ALREADY_PENDING ' +
    'while the student has a pending feedback of this trainer, and with 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a template that is neither the general one nor one of the trainer.',
  security,
  headers: authHeaders,
  params: uuidParams('studentId'),
  body: {
    type: 'object',
    nullable: true,
    additionalProperties: false,
    properties: { templateId: { type: 'string', format: 'uuid', description: 'Template to send: the general one or one of the trainer' } },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        ...i18nField('milestone', 'studentFeedbackMilestone'),
        ...i18nField('status', 'studentFeedbackStatus'),
        sentAt: dateTime,
        expiresAt: dateTime,
      },
    },
    ...errorResponses(400, 409),
  },
};

export const getConfigSchema = {
  tags: [TRAINER_TAG],
  summary: 'Get the student feedback settings of the trainer',
  description: 'Defaults (auto-send off, every milestone on) apply when never saved.',
  security,
  headers: authHeaders,
  response: { 200: configResponseSchema, ...errorResponses() },
};

export const updateConfigSchema = {
  tags: [TRAINER_TAG],
  summary: 'Update the student feedback settings of the trainer',
  description: 'Partial update: any subset of the booleans. Turning auto-send on never sends milestones that fell due before.',
  security,
  headers: authHeaders,
  body: { type: 'object', additionalProperties: false, properties: configBodyProperties },
  response: { 200: configResponseSchema, ...errorResponses(400) },
};

const milestoneListSchema = { type: 'array', items: { type: 'string', enum: studentFeedbackMilestoneValues }, description: 'Scheduled milestones that use the template' };

const templateHeaderProperties = {
  id: { type: 'string', format: 'uuid' },
  name: { type: 'string' },
  isGeneral: { type: 'boolean', description: 'The general template is read-only; duplicate it to edit' },
  version: { type: 'integer' },
};

const templateQuestionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    order: { type: 'integer' },
    text: { type: 'string' },
    helpText: { type: 'string', nullable: true },
    ...i18nField('type', 'studentFeedbackQuestionType'),
    ...i18nField('pillar', 'studentFeedbackPillar'),
    required: { type: 'boolean' },
    condition: { type: 'string', nullable: true, description: 'has_meal_plan: shown only to students with a meal plan' },
    invertScore: { type: 'boolean', description: 'A high answer is bad' },
    minLabel: { type: 'string', nullable: true },
    maxLabel: { type: 'string', nullable: true },
  },
};

const templateResponseSchema = {
  type: 'object',
  properties: {
    template: {
      type: 'object',
      properties: {
        ...templateHeaderProperties,
        hasRequests: { type: 'boolean', description: 'When true, saving creates a new version with a new id' },
        milestones: milestoneListSchema,
        questions: { type: 'array', items: templateQuestionSchema },
      },
    },
  },
};

// Optional text of a save body: omitted, null or up to the given length
function optionalText(maxLength) {
  return { type: 'string', nullable: true, maxLength };
}

const templateQuestionBody = {
  type: 'object',
  required: ['text', 'type', 'pillar'],
  additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: STUDENT_FEEDBACK_TEMPLATE_LIMITS.questionTextMaxLength },
    helpText: optionalText(STUDENT_FEEDBACK_TEMPLATE_LIMITS.helpTextMaxLength),
    type: { type: 'string', enum: studentFeedbackQuestionTypeValues },
    pillar: { type: 'string', enum: studentFeedbackPillarValues },
    required: { type: 'boolean', default: false },
    condition: { type: 'string', nullable: true, enum: [...studentFeedbackQuestionConditionValues, null] },
    invertScore: { type: 'boolean', default: false, description: 'Not allowed on open questions' },
    minLabel: { ...optionalText(STUDENT_FEEDBACK_TEMPLATE_LIMITS.labelMaxLength), description: 'Score questions only; dropped on the other types' },
    maxLabel: { ...optionalText(STUDENT_FEEDBACK_TEMPLATE_LIMITS.labelMaxLength), description: 'Score questions only; dropped on the other types' },
  },
};

const milestoneTemplateProperties = Object.fromEntries(
  MILESTONE_TEMPLATE_SLOTS.map(({ field }) => [field, { type: 'string', format: 'uuid', nullable: true, description: 'Template id; null = the general template' }]),
);
const milestoneTemplatesResponseSchema = {
  type: 'object',
  properties: { milestoneTemplates: { type: 'object', properties: milestoneTemplateProperties } },
};

export const listTemplatesSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'List the feedback templates the trainer can use',
  description: 'The general template first, then the latest version of each template of the trainer, by name.',
  security,
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: {
        templates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ...templateHeaderProperties, questionCount: { type: 'integer' }, milestones: milestoneListSchema, updatedAt: nullableDateTime },
          },
        },
      },
    },
    ...errorResponses(),
  },
};

export const getTemplateSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Get a feedback template with its questions',
  description: 'The general template or one of the trainer. Fails with 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND.',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  response: { 200: templateResponseSchema, ...errorResponses(400) },
};

export const createTemplateSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Create a feedback template',
  description:
    'Creates a template of the trainer (version 1) with the given name: with a copy of the questions of `sourceTemplateId` (the general template or one of the trainer), ' +
    'or, without it, with one starter question (score, pillar other, required) to be edited. Unknown body properties are ignored. ' +
    'Fails with 400 STUDENT_FEEDBACK_TEMPLATE_INVALID (blank name) or 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND (source the trainer cannot use).',
  security,
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength },
      sourceTemplateId: { type: 'string', format: 'uuid', description: 'Template whose questions are copied; omitted = one starter question' },
    },
  },
  response: { 201: templateResponseSchema, ...errorResponses(400) },
};

export const duplicateTemplateSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Duplicate a feedback template',
  description: 'Copies the general template or one of the trainer into a new template of the trainer (version 1, name with the copy suffix).',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  response: { 201: templateResponseSchema, ...errorResponses(400) },
};

export const saveTemplateSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Save the name and the questions of a feedback template',
  description:
    'Replaces the whole question list, in the order sent. A template with requests already sent is saved as a new version: the response carries a new id ' +
    'and the milestones follow it. Fails with 403 STUDENT_FEEDBACK_TEMPLATE_READ_ONLY (general template), 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND ' +
    'or 400 STUDENT_FEEDBACK_TEMPLATE_INVALID (blank name or text, invertScore on an open question, no question without a condition).',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  body: {
    type: 'object',
    required: ['name', 'questions'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength },
      questions: { type: 'array', minItems: 1, maxItems: STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions, items: templateQuestionBody },
    },
  },
  response: { 200: templateResponseSchema, ...errorResponses(400) },
};

export const deleteTemplateSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Delete a feedback template of the trainer',
  description:
    'Milestones that used it go back to the general template; feedbacks already sent keep it. ' +
    'Fails with 403 STUDENT_FEEDBACK_TEMPLATE_READ_ONLY (general template) or 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND.',
  security,
  headers: authHeaders,
  params: uuidParams('id'),
  response: { 204: { type: 'null', description: 'Deleted' }, ...errorResponses(400) },
};

export const getMilestoneTemplatesSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Get the feedback template of each milestone',
  description: 'null means the general template.',
  security,
  headers: authHeaders,
  response: { 200: milestoneTemplatesResponseSchema, ...errorResponses() },
};

export const updateMilestoneTemplatesSchema = {
  tags: [TEMPLATE_TAG],
  summary: 'Choose the feedback template of milestones',
  description:
    'Partial update: any subset of the milestones. null (or the id of the general template) goes back to the general template. ' +
    'Fails with 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a template the trainer cannot use.',
  security,
  headers: authHeaders,
  body: { type: 'object', additionalProperties: false, properties: milestoneTemplateProperties },
  response: { 200: milestoneTemplatesResponseSchema, ...errorResponses(400) },
};

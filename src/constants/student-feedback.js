/**
 * Student feedback to the trainer: enums, schedule and scoring constants, error codes.
 * Not to be confused with the beta feedback (trainer -> platform) in ./feedback.js.
 */

import { BUSINESS_TIMEZONE } from './subscription.js';

export const StudentFeedbackMilestone = Object.freeze({
  D7: 'D7',
  D15: 'D15',
  D21: 'D21',
  D30: 'D30',
  RECURRING: 'RECURRING',
  ADHOC: 'ADHOC',
});

export const StudentFeedbackStatus = Object.freeze({
  PENDING: 'pending',
  ANSWERED: 'answered',
  EXPIRED: 'expired',
});

export const StudentFeedbackQuestionType = Object.freeze({
  SCORE: 'score',
  STARS: 'stars',
  OPEN: 'open',
});

export const StudentFeedbackPillar = Object.freeze({
  TRAINING_ADHERENCE: 'training_adherence',
  DIET_ADHERENCE: 'diet_adherence',
  EVOLUTION: 'evolution',
  ROUTINE: 'routine',
  SLEEP: 'sleep',
  HYDRATION: 'hydration',
  REPORT: 'report',
  OTHER: 'other',
});

export const StudentFeedbackBand = Object.freeze({
  ATTENTION: 'attention',
  STABLE: 'stable',
  GOOD: 'good',
});

// Inbox status filter of the trainer: unread = answered and not read, unanswered = expired
export const StudentFeedbackInboxFilter = Object.freeze({
  ALL: 'all',
  UNREAD: 'unread',
  UNANSWERED: 'unanswered',
});

// Condition that shows a question only when the request meets it
export const StudentFeedbackQuestionCondition = Object.freeze({
  HAS_MEAL_PLAN: 'has_meal_plan',
});

export const studentFeedbackMilestoneValues = Object.freeze(Object.values(StudentFeedbackMilestone));
export const studentFeedbackInboxFilterValues = Object.freeze(Object.values(StudentFeedbackInboxFilter));
export const studentFeedbackPillarValues = Object.freeze(Object.values(StudentFeedbackPillar));

// Days after the trainer-student link on which a feedback is sent, then every RECURRING_INTERVAL_DAYS
export const MILESTONE_DAYS = Object.freeze([7, 15, 21, 30]);
export const RECURRING_INTERVAL_DAYS = 30;

// Milestone and config toggle of each fixed milestone day
export const MILESTONE_BY_DAY = Object.freeze({
  7: Object.freeze({ milestone: StudentFeedbackMilestone.D7, toggle: 'd7' }),
  15: Object.freeze({ milestone: StudentFeedbackMilestone.D15, toggle: 'd15' }),
  21: Object.freeze({ milestone: StudentFeedbackMilestone.D21, toggle: 'd21' }),
  30: Object.freeze({ milestone: StudentFeedbackMilestone.D30, toggle: 'd30' }),
});
export const RECURRING_MILESTONE = Object.freeze({ milestone: StudentFeedbackMilestone.RECURRING, toggle: 'recurring' });

// Feedbacks go out at 09:00 America/Sao_Paulo for everyone: no student timezone is stored
export const SEND_HOUR = 9;
export const SEND_TIME_ZONE = BUSINESS_TIMEZONE;
export const REMINDER_AFTER_HOURS = 24;

// Days a student has to answer a request: the default, and the range a trainer can choose from
export const RESPONSE_WINDOW_DAYS = 3;
export const RESPONSE_WINDOW_MIN_DAYS = 1;
export const RESPONSE_WINDOW_MAX_DAYS = 7;
export const RESPONSE_WINDOW_FIELD = 'responseWindowDays';

export const STUDENT_FEEDBACK_CONFIG_FIELDS = Object.freeze(['autoSendEnabled', 'd7', 'd15', 'd21', 'd30', 'recurring', RESPONSE_WINDOW_FIELD]);

export const DEFAULT_STUDENT_FEEDBACK_CONFIG = Object.freeze({
  autoSendEnabled: false,
  d7: true,
  d15: true,
  d21: true,
  d30: true,
  recurring: true,
  [RESPONSE_WINDOW_FIELD]: RESPONSE_WINDOW_DAYS,
});

// Allowed integer range of an answer, per scored question type
export const ANSWER_RANGES = Object.freeze({
  [StudentFeedbackQuestionType.SCORE]: Object.freeze({ min: 0, max: 10 }),
  [StudentFeedbackQuestionType.STARS]: Object.freeze({ min: 1, max: 5 }),
});
export const OPEN_ANSWER_MAX_LENGTH = 2000;

// Lower bounds of the stable and good bands of the 0-100 index; below stable is attention
export const BAND_THRESHOLDS = Object.freeze({ stable: 50, good: 75 });

export const RESPONSE_RATE_WINDOW_DAYS = 30;

// Inbox bounds: items returned per request, and how many of the most recent answered feedbacks feed the average index
export const INBOX_DEFAULT_LIMIT = 100;
export const INBOX_MAX_LIMIT = 200;
export const AVERAGE_INDEX_SAMPLE_SIZE = 1000;
export const ESTIMATED_SECONDS_PER_QUESTION = 20;

export const StudentFeedbackErrorCode = Object.freeze({
  NOT_FOUND: 'STUDENT_FEEDBACK_NOT_FOUND',
  EXPIRED: 'STUDENT_FEEDBACK_EXPIRED',
  ALREADY_SUBMITTED: 'STUDENT_FEEDBACK_ALREADY_SUBMITTED',
  ALREADY_PENDING: 'STUDENT_FEEDBACK_ALREADY_PENDING',
  REQUIRED_ANSWER_MISSING: 'STUDENT_FEEDBACK_REQUIRED_ANSWER_MISSING',
  INVALID_ANSWER: 'STUDENT_FEEDBACK_INVALID_ANSWER',
});

export const StudentFeedbackMessageCode = Object.freeze({
  NOT_FOUND: 'studentFeedback.notFound',
  EXPIRED: 'studentFeedback.expired',
  ALREADY_SUBMITTED: 'studentFeedback.alreadySubmitted',
  ALREADY_PENDING: 'studentFeedback.alreadyPending',
  REQUIRED_ANSWER_MISSING: 'studentFeedback.requiredAnswerMissing',
  INVALID_ANSWER: 'studentFeedback.invalidAnswer',
});

// Config toggle, milestone and config column of the template chosen for each scheduled milestone, in schedule order
export const MILESTONE_TEMPLATE_SLOTS = Object.freeze([
  Object.freeze({ field: 'd7', milestone: StudentFeedbackMilestone.D7, column: 'd7TemplateId' }),
  Object.freeze({ field: 'd15', milestone: StudentFeedbackMilestone.D15, column: 'd15TemplateId' }),
  Object.freeze({ field: 'd21', milestone: StudentFeedbackMilestone.D21, column: 'd21TemplateId' }),
  Object.freeze({ field: 'd30', milestone: StudentFeedbackMilestone.D30, column: 'd30TemplateId' }),
  Object.freeze({ field: 'recurring', milestone: StudentFeedbackMilestone.RECURRING, column: 'recurringTemplateId' }),
]);

export const studentFeedbackQuestionTypeValues = Object.freeze(Object.values(StudentFeedbackQuestionType));
export const studentFeedbackQuestionConditionValues = Object.freeze(Object.values(StudentFeedbackQuestionCondition));

// Bounds of a trainer-owned template
export const STUDENT_FEEDBACK_TEMPLATE_LIMITS = Object.freeze({
  maxQuestions: 15,
  nameMaxLength: 80,
  questionTextMaxLength: 300,
  helpTextMaxLength: 300,
  labelMaxLength: 60,
});

// Appended to the name of a duplicated template
export const STUDENT_FEEDBACK_TEMPLATE_COPY_SUFFIX = ' (cópia)';

// Locale namespace and key of the text of the question a template created from scratch starts with
export const STUDENT_FEEDBACK_TEXT_NAMESPACE = 'studentFeedback';
export const STUDENT_FEEDBACK_STARTER_QUESTION_TEXT_KEY = 'starterQuestionText';

export const StudentFeedbackTemplateErrorCode = Object.freeze({
  NOT_FOUND: 'STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND',
  READ_ONLY: 'STUDENT_FEEDBACK_TEMPLATE_READ_ONLY',
  INVALID: 'STUDENT_FEEDBACK_TEMPLATE_INVALID',
});

export const StudentFeedbackTemplateMessageCode = Object.freeze({
  NOT_FOUND: 'studentFeedbackTemplate.notFound',
  READ_ONLY: 'studentFeedbackTemplate.readOnly',
  INVALID: 'studentFeedbackTemplate.invalid',
});

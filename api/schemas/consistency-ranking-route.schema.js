import {
  Faixa,
  PANEL_RULE_RANGES,
  Pillar,
  SignalType,
  StandingsFilter,
  WeekStatus,
  pillarValues,
  standingsFilterValues,
} from '../../src/constants/consistency-ranking.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

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

const dateOnlyPattern = '^\\d{4}-\\d{2}-\\d{2}$';
const seasonWeeksValues = [4, 8, 12];

// JSON schema of an integer panel rule limited to its allowed range
function panelRuleSchema(rule, description) {
  const { min, max } = PANEL_RULE_RANGES[rule];
  return { type: 'integer', minimum: min, maximum: max, description };
}

const standingsQuerystring = {
  type: 'object',
  properties: {
    season: {
      type: 'integer',
      minimum: 1,
      description: 'Season number; omitted means the current season',
    },
  },
};

const pillarCountSchema = {
  type: 'object',
  properties: {
    expected: { type: 'integer' },
    done: { type: 'integer' },
  },
};

const seasonSchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    startWeek: { type: 'string', pattern: dateOnlyPattern, description: 'Monday of the first week (YYYY-MM-DD)' },
    endWeek: { type: 'string', pattern: dateOnlyPattern, description: 'Monday of the last week (YYYY-MM-DD)' },
    weeks: { type: 'integer' },
    currentWeek: { type: 'integer', description: 'Current week of the season, clamped to 1..weeks' },
    status: { type: 'string', enum: ['active', 'closed'] },
  },
};

const standingsRowSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    position: { type: 'integer' },
    eligible: { type: 'boolean' },
    average: { type: 'number', description: 'Season average score (0-100)' },
    validWeeks: { type: 'integer' },
    weeksAt100: { type: 'integer' },
    streak: { type: 'integer' },
    partialScore: {
      type: 'number',
      nullable: true,
      description: 'Running-week score; null when the week has no target. Absent on closed seasons',
    },
    weekStatus: {
      type: 'string',
      enum: ['valid', 'neutral', 'paused'],
      description: 'Running-week status. Absent on closed seasons',
    },
    pillars: {
      type: 'object',
      description: 'Running-week counts per pillar. Absent on closed seasons',
      properties: {
        workouts: pillarCountSchema,
        cardio: pillarCountSchema,
      },
    },
  },
};

const enteringItemSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    validWeeks: { type: 'integer' },
    weeksMissing: { type: 'integer' },
  },
};

const standingsResponseSchema = {
  type: 'object',
  properties: {
    season: { ...seasonSchema, nullable: true, description: 'null before the ranking launches' },
    rows: { type: 'array', items: standingsRowSchema },
    entering: { type: 'array', items: enteringItemSchema },
  },
};

const weightsSchema = {
  type: 'object',
  properties: {
    workouts: { type: 'integer', minimum: 0, maximum: 100 },
    diet: { type: 'integer', minimum: 0, maximum: 100 },
    cardio: { type: 'integer', minimum: 0, maximum: 100 },
    feedback: { type: 'integer', minimum: 0, maximum: 100 },
    hydration: { type: 'integer', minimum: 0, maximum: 100 },
  },
};

const configProperties = {
  weights: weightsSchema,
  activePillars: { type: 'array', items: { type: 'string', enum: pillarValues } },
  seasonWeeks: { type: 'integer', enum: seasonWeeksValues },
  minPodiumWeeks: { type: 'integer', minimum: 1, maximum: 4 },
  closeWeekday: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday' },
  closeHour: { type: 'integer', minimum: 0, maximum: 23 },
  timeZone: { type: 'string', description: 'IANA time zone (e.g., "America/Sao_Paulo")' },
  riskLimit: panelRuleSchema('riskLimit', 'Weekly score below which a week counts toward the risk alert'),
  riskWeeks: panelRuleSchema('riskWeeks', 'Valid closed weeks below the limit that raise the risk alert'),
  minWorkoutMinutes: panelRuleSchema('minWorkoutMinutes', 'Sessions shorter than this raise the quick-completion signal'),
  batchCount: panelRuleSchema('batchCount', 'Sessions finished together that raise the batch-logging signal'),
  batchMinutes: panelRuleSchema('batchMinutes', 'Minutes before the weekly close in which the batch is counted'),
};

const configResponseSchema = {
  type: 'object',
  properties: configProperties,
};

const updatedConfigResponseSchema = {
  type: 'object',
  properties: {
    ...configProperties,
    effectiveFrom: {
      type: 'string',
      pattern: dateOnlyPattern,
      nullable: true,
      description: 'Monday from which the new scoring rule applies; null when no rule changed',
    },
  },
};

const updateConfigBody = {
  type: 'object',
  properties: {
    weights: { ...weightsSchema, additionalProperties: false },
    activePillars: configProperties.activePillars,
    seasonWeeks: configProperties.seasonWeeks,
    minPodiumWeeks: configProperties.minPodiumWeeks,
    closeWeekday: configProperties.closeWeekday,
    closeHour: configProperties.closeHour,
    timeZone: configProperties.timeZone,
    riskLimit: configProperties.riskLimit,
    riskWeeks: configProperties.riskWeeks,
    minWorkoutMinutes: configProperties.minWorkoutMinutes,
    batchCount: configProperties.batchCount,
    batchMinutes: configProperties.batchMinutes,
  },
  additionalProperties: false,
};

const pauseBody = {
  type: 'object',
  required: ['weekStart'],
  properties: {
    weekStart: {
      type: 'string',
      pattern: dateOnlyPattern,
      description: 'Monday of the week (YYYY-MM-DD); the route rejects non-Mondays with 400',
    },
    studentId: {
      type: 'string',
      format: 'uuid',
      description: 'Omit to apply to the whole team',
    },
    reason: { type: 'string', maxLength: 255 },
  },
  additionalProperties: false,
};

const pauseResponseSchema = {
  type: 'object',
  properties: {
    weekStart: { type: 'string', pattern: dateOnlyPattern },
    studentId: { type: 'string', format: 'uuid', nullable: true },
    paused: { type: 'boolean' },
    reason: { type: 'string', nullable: true, description: 'Present on pause only' },
  },
};

export const getStandingsSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the consistency ranking standings of the trainer',
  description:
    'Returns the season, the ranked students and the students still entering the ranking. ' +
    'Without `season` it returns the current season; `season` selects a closed one. ' +
    'Before the ranking launches `season` is null and the lists are empty. ' +
    'Closed seasons omit partialScore, weekStatus and pillars from each row.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: standingsQuerystring,
  response: {
    200: standingsResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const adminGetStandingsSchema = {
  tags: ['admin-consistency-ranking'],
  summary: 'Get the consistency ranking standings of a trainer (admin)',
  description:
    'Same payload as the trainer standings route, for any trainer. Requires the admin role.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['trainerId'],
    properties: { trainerId: { type: 'string', format: 'uuid' } },
  },
  querystring: standingsQuerystring,
  response: {
    200: standingsResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getConfigSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the consistency ranking configuration of the trainer',
  description:
    'Returns the scoring weights, active pillars, weekly close rule, season length ' +
    'and minimum weeks to be eligible for the podium. Defaults apply when never configured.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: configResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateConfigSchema = {
  tags: ['consistency-ranking'],
  summary: 'Update the consistency ranking configuration of the trainer',
  description:
    'Partial update. Scoring and close-rule changes take effect from the next Monday ' +
    '(`effectiveFrom`); `seasonWeeks` applies from the next season.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: updateConfigBody,
  response: {
    200: updatedConfigResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const pauseWeekSchema = {
  tags: ['consistency-ranking'],
  summary: 'Pause a week for the team or for one student',
  description:
    'Marks the week as paused so it does not count toward the ranking. ' +
    'Fails with 409 when the week is no longer editable and 404 for an unknown student.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: pauseBody,
  response: {
    200: pauseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const resumeWeekSchema = {
  tags: ['consistency-ranking'],
  summary: 'Resume a paused week for the team or for one student',
  description:
    'Removes the pause (or reactivates a student of a paused team week). ' +
    'The target travels in the JSON request body, like the pause route.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: pauseBody,
  response: {
    200: pauseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const closeRequestResponseSchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    startWeek: { type: 'string', pattern: dateOnlyPattern },
    weeks: { type: 'integer' },
    status: { type: 'string', enum: ['active', 'closed'] },
    closeRequestedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const closeCurrentSeasonSchema = {
  tags: ['consistency-ranking'],
  summary: 'Request the early close of the current season',
  description:
    'The season ends after the next weekly close. Returns 404 when there is no active season.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: closeRequestResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const faixaValues = Object.values(Faixa);
const signalTypeValues = Object.values(SignalType);
const weekStatusValues = Object.values(WeekStatus);
const targetPillarValues = [Pillar.WORKOUTS, Pillar.CARDIO];

const panelStandingsQuerystring = {
  type: 'object',
  properties: {
    ...standingsQuerystring.properties,
    filter: { type: 'string', enum: standingsFilterValues, default: StandingsFilter.ALL, description: 'Group of students to return' },
    q: { type: 'string', maxLength: 100, description: 'Student name search, ignoring case and accents' },
  },
  additionalProperties: false,
};

const seasonPillarSchema = {
  type: 'object',
  properties: {
    pillar: { type: 'string', enum: pillarValues },
    done: { type: 'integer', description: 'Sessions done in the closed weeks, each week capped at its target' },
    expected: { type: 'integer', description: 'Sessions expected in the closed weeks' },
    adherence: { type: 'number', description: 'Percentage 0-100' },
  },
};

const riskSchema = {
  type: 'object',
  nullable: true,
  description: 'Present while the last valid closed weeks are below the risk limit',
  properties: {
    weeks: { type: 'integer' },
    scores: { type: 'array', items: { type: 'number' }, description: 'Scores of those weeks, oldest first' },
  },
};

const signalSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: signalTypeValues },
    sessionId: { type: 'string', format: 'uuid', description: 'Quick completion only' },
    finishedAt: { type: 'string', format: 'date-time', description: 'Quick completion only' },
    durationSeconds: { type: 'integer', description: 'Quick completion only' },
    count: { type: 'integer', description: 'Batch logging only' },
    closeInstant: { type: 'string', format: 'date-time', description: 'Batch logging only' },
  },
};

const pauseInfoSchema = {
  type: 'object',
  nullable: true,
  description: 'Present while the running week is paused for the student',
  properties: {
    weekStart: { type: 'string', pattern: dateOnlyPattern },
    reason: { type: 'string', nullable: true },
  },
};

const enteringInfoSchema = {
  type: 'object',
  nullable: true,
  description: 'Present while the student lacks the valid weeks for the podium',
  properties: {
    validWeeks: { type: 'integer' },
    required: { type: 'integer' },
  },
};

const panelRowSchema = {
  type: 'object',
  properties: {
    ...standingsRowSchema.properties,
    displayName: { type: 'string', description: 'First name and initial of the last name' },
    initials: { type: 'string' },
    faixa: { type: 'string', enum: faixaValues },
    currentWeekScore: { type: 'number', nullable: true },
    weeks100: { type: 'integer' },
    weeksMissing: { type: 'integer', description: 'Entering students only' },
    seasonPillars: { type: 'array', items: seasonPillarSchema },
    risk: riskSchema,
    signals: { type: 'array', items: signalSchema },
    pause: pauseInfoSchema,
    entering: enteringInfoSchema,
  },
};

const panelEnteringRowSchema = {
  type: 'object',
  properties: {
    ...panelRowSchema.properties,
    position: { type: 'integer', nullable: true, description: 'Always null: students still entering have no position' },
    average: { type: 'number', nullable: true },
  },
};

const panelStandingsResponseSchema = {
  type: 'object',
  properties: {
    season: {
      type: 'object',
      nullable: true,
      properties: {
        ...seasonSchema.properties,
        closesAt: { type: 'string', format: 'date-time', nullable: true, description: 'Close instant of the running week; null on closed seasons' },
      },
    },
    summary: {
      type: 'object',
      properties: {
        teamAverage: { type: 'number', nullable: true },
        lastClosedWeekAverage: { type: 'number', nullable: true },
        fullLastWeek: { type: 'integer' },
        validLastWeek: { type: 'integer' },
        atRisk: { type: 'integer' },
        withSignal: { type: 'integer' },
      },
    },
    counts: {
      type: 'object',
      properties: Object.fromEntries(standingsFilterValues.map((filterValue) => [filterValue, { type: 'integer' }])),
    },
    rows: { type: 'array', items: panelRowSchema },
    entering: { type: 'array', items: panelEnteringRowSchema },
  },
};

const studentParams = {
  type: 'object',
  required: ['studentId'],
  properties: { studentId: { type: 'string', format: 'uuid' } },
};

const studentPanelResponseSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    whatsapp: { type: 'string', nullable: true },
    displayName: { type: 'string', nullable: true },
    initials: { type: 'string' },
    position: { type: 'integer', nullable: true },
    total: { type: 'integer', description: 'Ranked students' },
    average: { type: 'number', nullable: true },
    faixa: { type: 'string', enum: faixaValues },
    risk: riskSchema,
    pause: pauseInfoSchema,
    signals: { type: 'array', items: signalSchema },
    seasonPillars: { type: 'array', items: seasonPillarSchema },
    weakestPillar: { type: 'string', enum: pillarValues, nullable: true },
    riskLimit: { type: 'integer' },
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          weekStart: { type: 'string', pattern: dateOnlyPattern },
          number: { type: 'integer' },
          state: { type: 'string', enum: ['closed', 'current', 'future'] },
          status: { type: 'string', enum: weekStatusValues, nullable: true },
          score: { type: 'number', nullable: true, description: 'Closed weeks: stored score; current week: partial' },
        },
      },
    },
    previousSeasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          startWeek: { type: 'string', pattern: dateOnlyPattern },
          endWeek: { type: 'string', pattern: dateOnlyPattern },
          average: { type: 'number', nullable: true },
          faixa: { type: 'string', enum: faixaValues },
        },
      },
    },
    lastContact: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const getStandingsPanelSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the consistency ranking standings of the trainer with the panel fields',
  description:
    'Returns the season, the four summary numbers, the count of every filter and the students: ranked ones in `rows`, ' +
    'students still entering in `entering`. Each student carries band, season pillars, risk, review signals, pause and entering progress. ' +
    '`filter` and `q` narrow the lists (the counts and the summary stay global); `filter=risk` orders by ascending average. ' +
    'Without `season` it returns the current season; `season` selects a closed one. Before the ranking launches `season` is null.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: panelStandingsQuerystring,
  response: {
    200: panelStandingsResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getStudentPanelSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the ranking panel of one student',
  description:
    'Standing, risk, week-by-week chart, season pillars, weakest pillar, previous seasons and last WhatsApp contact. ' +
    'Returns 404 for a student that is not linked to the trainer.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: studentParams,
  response: {
    200: studentPanelResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const logContactSchema = {
  tags: ['consistency-ranking'],
  summary: 'Log one use of "open on WhatsApp" for a student',
  description: 'Every call is stored with trainer, student, pillar and date. Returns 404 for a student that is not linked to the trainer.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: studentParams,
  body: {
    type: 'object',
    properties: { pillar: { type: 'string', enum: pillarValues, description: 'Weakest pillar the message was about' } },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        studentId: { type: 'string', format: 'uuid' },
        pillar: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const adjustTargetSchema = {
  tags: ['consistency-ranking'],
  summary: 'Lower the target of one pillar for the running week',
  description:
    'Sets the target of the pillar for the running week only, from 0 up to the frozen target. ' +
    'Returns 409 for a closed week or a value above the frozen target, and 404 for a student that is not linked to the trainer.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: studentParams,
  body: {
    type: 'object',
    required: ['pillar', 'value'],
    properties: {
      pillar: { type: 'string', enum: targetPillarValues },
      value: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        weekStart: { type: 'string', pattern: dateOnlyPattern },
        pillar: { type: 'string', enum: targetPillarValues },
        expected: { type: 'integer', description: 'Frozen target' },
        adjusted: { type: 'integer', description: 'Target now in force' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getHistorySchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the general history of the team',
  description:
    'Students with 4 or more valid weeks: average of every valid week since the join, weeks at 100 and longest run at 100, ordered by average.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              studentId: { type: 'string', format: 'uuid' },
              displayName: { type: 'string' },
              initials: { type: 'string' },
              validWeeks: { type: 'integer' },
              average: { type: 'number', nullable: true },
              weeks100: { type: 'integer' },
              longestStreak: { type: 'integer' },
            },
          },
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getSeasonsSchema = {
  tags: ['consistency-ranking'],
  summary: 'List the closed seasons of the trainer',
  description: 'Number, dates, participants and average of each closed season, newest first. Open one with `standings?season=<number>`.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: {
        seasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              startWeek: { type: 'string', pattern: dateOnlyPattern },
              endWeek: { type: 'string', pattern: dateOnlyPattern },
              weeks: { type: 'integer' },
              participants: { type: 'integer' },
              average: { type: 'number', nullable: true, description: 'Mean of the eligible students averages' },
            },
          },
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

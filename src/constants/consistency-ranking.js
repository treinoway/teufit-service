/**
 * Consistency ranking constants
 */

import { BUSINESS_TIMEZONE } from './subscription.js';
import { TrainingCategory } from './training.js';

export const Pillar = Object.freeze({
  WORKOUTS: 'workouts',
  DIET: 'diet',
  CARDIO: 'cardio',
  FEEDBACK: 'feedback',
  HYDRATION: 'hydration',
});

export const pillarValues = Object.freeze(Object.values(Pillar));

// Rest is intentionally absent: it never counts toward any pillar (AD-004)
export const CATEGORY_TO_PILLAR = Object.freeze({
  [TrainingCategory.STRENGTH]: Pillar.WORKOUTS,
  [TrainingCategory.FUNCTIONAL]: Pillar.WORKOUTS,
  [TrainingCategory.MOBILITY]: Pillar.WORKOUTS,
  [TrainingCategory.FLEXIBILITY]: Pillar.WORKOUTS,
  [TrainingCategory.CARDIO]: Pillar.CARDIO,
});

export const WeekStatus = Object.freeze({
  VALID: 'valid',
  NEUTRAL: 'neutral',
  PAUSED: 'paused',
});

export const SeasonStatus = Object.freeze({
  ACTIVE: 'active',
  CLOSED: 'closed',
});

// Why the trainer panel has no current season (PAN-60), mirroring the order of the season rules
export const SeasonNotStartedReason = Object.freeze({
  LAUNCH_PENDING: 'launchPending',
  NO_ACTIVE_STUDENT: 'noActiveStudent',
  BETWEEN_SEASONS: 'betweenSeasons',
});

export const seasonNotStartedReasonValues = Object.freeze(Object.values(SeasonNotStartedReason));

export const DEFAULT_CONFIG = Object.freeze({
  weights: Object.freeze({
    [Pillar.WORKOUTS]: 30,
    [Pillar.DIET]: 30,
    [Pillar.CARDIO]: 15,
    [Pillar.FEEDBACK]: 15,
    [Pillar.HYDRATION]: 10,
  }),
  activePillars: Object.freeze([Pillar.WORKOUTS, Pillar.CARDIO, Pillar.FEEDBACK, Pillar.HYDRATION]),
  seasonWeeks: 4,
  minPodiumWeeks: 2,
  closeWeekday: 0,
  closeHour: 21,
  timeZone: BUSINESS_TIMEZONE,
});

export const MAX_PAUSE_WEEKS_AHEAD = 12;

// Error codes for the consistency ranking (config, pause, season)
export const ConsistencyErrorCode = Object.freeze({
  CONFIG_INVALID: 'CONSISTENCY_CONFIG_INVALID',
  PAUSE_WEEK_NOT_EDITABLE: 'CONSISTENCY_PAUSE_WEEK_NOT_EDITABLE',
  SEASON_NOT_FOUND: 'CONSISTENCY_SEASON_NOT_FOUND',
  TARGET_NOT_EDITABLE: 'CONSISTENCY_TARGET_NOT_EDITABLE',
  TRAINER_PROFILE_MISSING: 'CONSISTENCY_TRAINER_PROFILE_MISSING',
});

export const ConsistencyMessageCode = Object.freeze({
  CONFIG_INVALID: 'consistencyRanking.config.invalid',
  PAUSE_WEEK_NOT_EDITABLE: 'consistencyRanking.pause.weekNotEditable',
  SEASON_NOT_FOUND: 'consistencyRanking.season.notFound',
  TARGET_NOT_EDITABLE: 'consistencyRanking.target.notEditable',
  TRAINER_PROFILE_MISSING: 'trainer.notFound',
});

// Season band shown next to a student's average (AD-011)
export const Faixa = Object.freeze({
  FULL: 'full',
  CONSTANT: 'constant',
  STEADY: 'steady',
  RESTARTING: 'restarting',
  ENTERING: 'entering',
});

// Lower bounds of the Constant and Steady bands; below the Steady bound is Restarting
export const FAIXA_THRESHOLDS = Object.freeze({ constant: 85, steady: 70 });

export const SignalType = Object.freeze({
  QUICK_COMPLETION: 'quick_completion',
  BATCH_LOGGING: 'batch_logging',
});

// Order that breaks ties between equally weak pillars
export const PILLAR_TIE_ORDER = Object.freeze([
  Pillar.WORKOUTS,
  Pillar.CARDIO,
  Pillar.FEEDBACK,
  Pillar.HYDRATION,
  Pillar.DIET,
]);

// Defaults of the trainer panel rules (risk alert, quick completion, batch logging)
export const PANEL_DEFAULTS = Object.freeze({
  riskLimit: 70,
  riskWeeks: 2,
  minWorkoutMinutes: 10,
  batchCount: 5,
  batchMinutes: 30,
});

// Groups of the standings filter chips
export const StandingsFilter = Object.freeze({
  ALL: 'all',
  RISK: 'risk',
  SIGNAL: 'signal',
  ENTERING: 'entering',
  PAUSED: 'paused',
});

export const standingsFilterValues = Object.freeze(Object.values(StandingsFilter));

// Allowed integer ranges of the panel rules the trainer can configure
export const PANEL_RULE_RANGES = Object.freeze({
  riskLimit: Object.freeze({ min: 50, max: 90 }),
  riskWeeks: Object.freeze({ min: 1, max: 4 }),
  minWorkoutMinutes: Object.freeze({ min: 0, max: 60 }),
  batchCount: Object.freeze({ min: 2, max: 20 }),
  batchMinutes: Object.freeze({ min: 10, max: 120 }),
});

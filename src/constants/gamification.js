/**
 * Gamification system constants
 */

export const PointAction = Object.freeze({
  WORKOUT_COMPLETED: 'workout_completed',
  STREAK_7_DAYS: 'streak_7_days',
  STREAK_30_DAYS: 'streak_30_days',
  DAILY_CHECKIN: 'daily_checkin',
  EVOLUTION_RECORD: 'evolution_record',
  WORKOUT_FEEDBACK: 'workout_feedback',
  TRAINER_BONUS: 'trainer_bonus',
});

export const pointActionValues = Object.freeze(Object.values(PointAction));

export const DEFAULT_POINT_VALUES = Object.freeze({
  [PointAction.WORKOUT_COMPLETED]: 10,
  [PointAction.STREAK_7_DAYS]: 50,
  [PointAction.STREAK_30_DAYS]: 250,
  [PointAction.DAILY_CHECKIN]: 2,
  [PointAction.EVOLUTION_RECORD]: 15,
  [PointAction.WORKOUT_FEEDBACK]: 5,
});

export const ACTION_TO_CONFIG_FIELD = Object.freeze({
  [PointAction.WORKOUT_COMPLETED]: 'ptsWorkoutCompleted',
  [PointAction.STREAK_7_DAYS]: 'ptsStreak7Days',
  [PointAction.STREAK_30_DAYS]: 'ptsStreak30Days',
  [PointAction.DAILY_CHECKIN]: 'ptsDailyCheckin',
  [PointAction.EVOLUTION_RECORD]: 'ptsEvolutionRecord',
  [PointAction.WORKOUT_FEEDBACK]: 'ptsWorkoutFeedback',
});

export const DEFAULT_STREAK_TOLERANCE_HOURS = 24;

// Error codes for gamification (config + points)
export const GamificationErrorCode = Object.freeze({
  CONFIG_NOT_FOUND: 'GAMIFICATION_CONFIG_NOT_FOUND',
  TRAINER_PROFILE_MISSING: 'TRAINER_PROFILE_MISSING',
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
  STUDENT_NOT_TRAINEE: 'STUDENT_NOT_TRAINEE',
  ACTION_DISABLED: 'GAMIFICATION_ACTION_DISABLED',
  CHALLENGE_NOT_ACTIVE: 'CHALLENGE_NOT_ACTIVE',
  GLOBAL_RANKING_REMOVED: 'GLOBAL_RANKING_REMOVED',
});

export const GamificationMessageCode = Object.freeze({
  CONFIG_NOT_FOUND: 'gamification.config.notFound',
  TRAINER_PROFILE_MISSING: 'trainer.notFound',
  STUDENT_NOT_FOUND: 'student.notFound',
  STUDENT_NOT_TRAINEE: 'student.notTrainee',
  ACTION_DISABLED: 'gamification.action.disabled',
  CHALLENGE_NOT_ACTIVE: 'challenge.notActive',
  GLOBAL_RANKING_REMOVED: 'gamification.globalRankingRemoved',
});

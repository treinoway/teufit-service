/**
 * Constants for the Trainer Briefing feature.
 * All time windows are in days (UTC).
 */

export const BriefingThresholds = Object.freeze({
  ACTIVE_WINDOW_DAYS: 30,
  RETURNING_GAP_DAYS: 7,
  STAGNANT_NO_PR_DAYS: 14,
  STAGNANT_HISTORY_DAYS: 180,
  INACTIVE_NO_SESSION_DAYS: 7,
});

export const BriefingErrorCode = Object.freeze({
  NOT_AVAILABLE: 'BRIEFING_NOT_AVAILABLE',
});

export const BriefingMessageCode = Object.freeze({
  NOT_AVAILABLE: 'briefing.notAvailable',
});

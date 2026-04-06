/**
 * Challenge (Campeonato) system constants
 */

export const ChallengeParticipantMode = Object.freeze({
  EXPLICIT: 'explicit',
  FILTER: 'filter',
  ALL: 'all',
});

export const challengeParticipantModeValues = Object.freeze(Object.values(ChallengeParticipantMode));

export const ChallengeStatus = Object.freeze({
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const challengeStatusValues = Object.freeze(Object.values(ChallengeStatus));

export const CHALLENGE_NAME_MAX_LENGTH = 100;
export const CHALLENGE_MAX_DURATION_DAYS = 365;

// Error codes
export const ChallengeErrorCode = Object.freeze({
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  CHALLENGE_INVALID_DATES: 'CHALLENGE_INVALID_DATES',
  CHALLENGE_ALREADY_STARTED: 'CHALLENGE_ALREADY_STARTED',
  CHALLENGE_ALREADY_ENDED: 'CHALLENGE_ALREADY_ENDED',
  CHALLENGE_ALREADY_CANCELLED: 'CHALLENGE_ALREADY_CANCELLED',
  CHALLENGE_NOT_DELETABLE: 'CHALLENGE_NOT_DELETABLE',
  CHALLENGE_FORBIDDEN_NOT_OWNER: 'CHALLENGE_FORBIDDEN_NOT_OWNER',
  CHALLENGE_PARTICIPANT_NOT_TRAINEE: 'CHALLENGE_PARTICIPANT_NOT_TRAINEE',
  CHALLENGE_PARTICIPANT_DUPLICATE: 'CHALLENGE_PARTICIPANT_DUPLICATE',
  CHALLENGE_PARTICIPANT_NOT_FOUND: 'CHALLENGE_PARTICIPANT_NOT_FOUND',
  CHALLENGE_FILTER_EMPTY: 'CHALLENGE_FILTER_EMPTY',
  CHALLENGE_DURATION_EXCEEDED: 'CHALLENGE_DURATION_EXCEEDED',
  CHALLENGE_NOT_SCHEDULABLE: 'CHALLENGE_NOT_ACTIVE',
  TRAINER_PROFILE_MISSING: 'TRAINER_PROFILE_MISSING',
});

export const ChallengeMessageCode = Object.freeze({
  CHALLENGE_NOT_FOUND: 'challenge.notFound',
  CHALLENGE_INVALID_DATES: 'challenge.invalidDates',
  CHALLENGE_ALREADY_STARTED: 'challenge.alreadyStarted',
  CHALLENGE_ALREADY_ENDED: 'challenge.alreadyEnded',
  CHALLENGE_ALREADY_CANCELLED: 'challenge.alreadyCancelled',
  CHALLENGE_NOT_DELETABLE: 'challenge.notDeletable',
  CHALLENGE_FORBIDDEN_NOT_OWNER: 'challenge.forbidden.notOwner',
  CHALLENGE_PARTICIPANT_NOT_TRAINEE: 'challenge.participant.notTrainee',
  CHALLENGE_PARTICIPANT_DUPLICATE: 'challenge.participant.duplicate',
  CHALLENGE_PARTICIPANT_NOT_FOUND: 'challenge.participant.notFound',
  CHALLENGE_FILTER_EMPTY: 'challenge.filter.empty',
  CHALLENGE_DURATION_EXCEEDED: 'challenge.durationExceeded',
  CHALLENGE_NOT_SCHEDULABLE: 'challenge.notActive',
  TRAINER_PROFILE_MISSING: 'trainer.notFound',
});

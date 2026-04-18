/**
 * en-US locale for Treinoway Service.
 * Missing keys fall back to pt-BR (the canonical locale).
 *
 * Structure mirrors pt-BR.js — see that file for full documentation.
 */

export default {
  categorical: {
    trainingCategory: {
      strength: 'Strength',
      cardio: 'Cardio',
      flexibility: 'Flexibility',
      rest: 'Rest',
      functional: 'Functional',
      mobility: 'Mobility',
    },
    bodySegment: {
      upper: 'Upper',
      lower: 'Lower',
      core: 'Core',
      full_body: 'Full Body',
    },
    weekDay: {
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday',
      sunday: 'Sunday',
    },
    trainingStatus: {
      active: 'Active',
      completed: 'Completed',
      archived: 'Archived',
    },
    protocolStatus: {},
    genderOrdination: {
      male: 'Male',
      female: 'Female',
      other: 'Other',
    },
    trainingLevel: {
      beginner: 'Beginner',
      intermediate: 'Intermediate',
      advanced: 'Advanced',
      athlete: 'Athlete',
    },
    protocolType: {
      strength: 'Strength',
      cardio: 'Cardio',
      stretching: 'Stretching',
      mobility: 'Mobility',
      activation: 'Activation',
    },
    exerciseType: {
      strength: 'Strength',
      cardio: 'Cardio',
      mobility: 'Mobility',
      stretching: 'Stretching',
    },
    workoutSessionStatus: {
      in_progress: 'In Progress',
      completed: 'Completed',
      abandoned: 'Abandoned',
    },
    exerciseLogStatus: {
      pending: 'Pending',
      completed: 'Completed',
      skipped: 'Skipped',
    },
    challengeParticipantMode: {
      explicit: 'Explicit',
      filter: 'By filter',
      all: 'All',
    },
    challengeStatus: {
      scheduled: 'Scheduled',
      active: 'Active',
      completed: 'Completed',
      cancelled: 'Cancelled',
    },
    pointAction: {},
    anamnesisQuestionType: {
      free_text: 'Free text',
      dichotomous: 'Dichotomous',
      multiple_choice: 'Multiple choice',
      numeric: 'Numeric',
      single_choice: 'Single choice',
      matrix: 'Matrix',
    },
    userStatus: {
      pending: 'Pending',
      active: 'Active',
    },
    userGender: {
      male: 'Male',
      female: 'Female',
      other: 'Other',
      prefer_not_to_say: 'Prefer not to say',
    },
    userRole: {
      trainer: 'Trainer',
      admin: 'Administrator',
    },
    trainerServiceMode: {
      online: 'Online',
      in_person: 'In Person',
      hybrid: 'Hybrid',
    },
  },

  errors: {
    // HTTP-status mapped codes
    'request.badRequest': 'Invalid request. Please check your data and try again.',
    'auth.unauthorized': 'Session expired. Please log in again.',
    'auth.invalidCredentials': 'Invalid email or password.',
    'auth.forbidden': 'You do not have permission to perform this action.',
    'resource.notFound': 'Resource not found.',
    'resource.conflict': 'This record already exists.',
    'request.rateLimitExceeded': 'Too many requests. Please wait a moment and try again.',
    'internal.serverError': 'Internal server error. Please try again later.',
    'validation.failed': 'Invalid data. Please check your fields and try again.',

    // Database-level codes
    'database.uniqueConstraint': 'This record already exists.',
    'database.recordNotFound': 'Record not found.',

    // Student/trainer relationship
    'student.notFound': 'No user found with this email.',
    'student.cannotLinkSelf': 'You cannot link yourself as your own student.',
    'student.alreadyLinked': 'This student is already linked to your account.',
    'student.notLinked': 'This student is not linked to your account.',
    'student.notTrainee': 'This student does not belong to your roster.',
    'trainer.notFound': 'Trainer profile not found.',

    // Branding
    'branding.notFound': 'Branding not found. Please save your settings first.',

    // Workout session
    'workoutSession.alreadyInProgress': 'You already have a workout session in progress.',

    // Anamnesis
    'anamnesis.notFound': 'Anamnesis not found.',
    'anamnesis.section.notFound': 'Section not found.',
    'anamnesis.question.notFound': 'Question not found.',
    'anamnesis.forbidden.notOwner': 'You do not have access to this anamnesis.',
    'anamnesis.forbidden.general': 'General anamneses cannot be edited.',
    'anamnesis.invalidQuestionType': 'Invalid question type.',
    'anamnesis.alreadyLinked': 'This anamnesis is already linked to this student.',
    'anamnesis.hasStudentLinks': 'This anamnesis is linked to students. Please create a new version before editing.',
    'anamnesis.response.notFound': 'No response found for this anamnesis.',
    'anamnesis.notLinkedToStudent': 'This anamnesis is not linked to your profile.',

    // Import
    'import.primecoaching.formatChanged': 'The file does not match the expected PrimeCoaching format. Please verify you exported the correct spreadsheet.',

    // AI assistant
    'ai.trainerNotFound': 'Trainer profile not found.',
    'ai.conversationNotFound': 'Conversation not found.',
    'ai.rateLimited': 'Too many messages sent. Please wait a moment.',
    'ai.modelError': 'The assistant is temporarily unavailable. Please try again.',
    'ai.overloaded': 'The assistant is currently overloaded. Please try again in a moment.',
    'ai.exerciseTemplateNotOwned': 'Exercise template does not belong to you.',
    'ai.trainingTemplateNotOwned': 'Training template does not belong to you.',

    // Gamification
    'gamification.config.notFound': 'Gamification configuration not found.',
    'gamification.action.disabled': 'This action has been disabled by your trainer.',
    'gamification.ranking.insufficientStudents': 'At least 3 active students (last 14 days) are required to display the ranking.',
    'gamification.globalRankingRemoved': 'The global ranking has been discontinued. Use challenges instead.',

    // Training template exercises
    'trainingTemplateExercise.notFound': 'Exercise not found in this training template.',

    // Challenge
    'challenge.notFound': 'Challenge not found.',
    'challenge.invalidDates': 'Invalid challenge dates. The start date must be today or in the future, and the end date must be equal to or after the start date.',
    'challenge.alreadyStarted': 'This challenge has already started and cannot be modified this way.',
    'challenge.alreadyEnded': 'This challenge has already ended.',
    'challenge.alreadyCancelled': 'This challenge has already been cancelled.',
    'challenge.notDeletable': 'This challenge cannot be deleted. Only scheduled challenges can be removed.',
    'challenge.forbidden.notOwner': 'You do not have permission to access this challenge.',
    'challenge.participant.notTrainee': 'One or more selected students do not belong to your roster.',
    'challenge.participant.duplicate': 'This student is already participating in the challenge.',
    'challenge.participant.notFound': 'Participant not found in this challenge.',
    'challenge.filter.empty': 'No students match the filter criteria.',
    'challenge.durationExceeded': 'Challenge duration cannot exceed 365 days.',
    'challenge.notActive': 'This challenge is not active.',

    // Workouts Today
    'workoutsToday.noActiveProtocol': 'You do not have an active training protocol.',
    'workoutsToday.emptyProtocol': 'Your active protocol does not have any workouts yet.',
  },

  validation: {
    required: 'The field {field} is required.',
    type: 'The field {field} has an invalid type.',
    format: 'The field {field} has an invalid format.',
    minLength: 'The field {field} must be at least {min} characters long.',
    maxLength: 'The field {field} must be at most {max} characters long.',
    minimum: 'The field {field} must be at least {min}.',
    maximum: 'The field {field} must be at most {max}.',
    enum: 'The value of field {field} is invalid. Allowed values: {allowedValues}.',
    pattern: 'The field {field} does not match the expected pattern.',
    additionalProperties: 'Additional fields are not allowed.',
    invalid: 'The field {field} is invalid.',
  },
};

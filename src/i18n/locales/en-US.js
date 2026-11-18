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
    exerciseIntensity: {
      very_light: 'Very light',
      light: 'Light',
      moderate: 'Moderate',
      vigorous: 'Vigorous',
      near_maximal: 'Near-maximal',
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
      substituted: 'Substituted',
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
    anamnesisResponseStatus: {
      draft: 'Draft',
      awaiting_confirmation: 'Awaiting confirmation',
      submitted: 'Submitted',
    },
    anamnesisFilledBy: {
      student: 'Student',
      trainer: 'Trainer',
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
      nutritionist: 'Nutritionist',
      admin: 'Administrator',
    },
    trainerServiceMode: {
      online: 'Online',
      in_person: 'In Person',
      hybrid: 'Hybrid',
    },
    billingStatus: {
      overdue: 'Overdue',
      due_soon: 'Due soon',
      ok: 'Up to date',
      none: 'No plan',
    },
    studentBlocker: {
      no_active_protocol: 'No active routine',
      no_subscription: 'No plan',
      subscription_cancelled: 'Plan cancelled',
      subscription_overdue: 'Payment overdue',
      blocked_on_plan: 'Blocked by your quota',
    },
    subscriptionRecurrence: {
      monthly: 'Monthly',
      quarterly: 'Quarterly',
      semiannual: 'Semiannual',
      annual: 'Annual',
    },
    feedbackCategory: {
      BUG: 'Problem',
      SUGGESTION: 'Suggestion',
      PRAISE: 'Praise',
    },
    subscriptionStatus: {
      active: 'Active',
      cancelled: 'Cancelled',
    },
    paymentStatus: {
      pending: 'Pending',
      paid: 'Paid',
      overdue: 'Overdue',
      cancelled: 'Voided',
    },
    inviteStatus: {
      pending: 'Pending',
      accepted: 'Accepted',
      revoked: 'Revoked',
      expired: 'Expired',
      declined: 'Declined',
    },
  },

  errors: {
    // HTTP-status mapped codes
    'request.badRequest': 'Invalid request. Please check your data and try again.',
    'auth.unauthorized': 'Session expired. Please log in again.',
    'auth.invalidCredentials': 'Invalid email or password.',
    'auth.forbidden': 'You do not have permission to perform this action.',
    'auth.apple.identityTokenRequired': 'Missing Apple identity token.',
    'auth.apple.firstLoginRequiresEmail': 'First Apple login requires an email. Please sign in again.',
    'auth.apple.invalidToken': 'Invalid Apple token.',
    'auth.apple.failed': 'Authentication failed. Please try again.',
    'auth.oauthEmailNotVerified': 'This provider has not verified your email. Verify the email on your account or sign in with email and password.',
    'auth.user.deleted': 'This account has been deleted.',
    'account.deletion.professionalUnsupported': 'Account deletion is not yet available for trainer or nutritionist accounts. Please contact support to close a professional account.',
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
    'nutritionist.notFound': 'Nutritionist profile not found.',

    // Branding
    'branding.notFound': 'Branding not found. Please save your settings first.',

    // Workout session
    'workoutSession.alreadyInProgress': 'You already have a workout session in progress.',
    'workoutSession.finalized': 'Cannot modify a finalized workout session.',

    // Anamnesis
    'anamnesis.notFound': 'Anamnesis not found.',
    'anamnesis.section.notFound': 'Section not found.',
    'anamnesis.question.notFound': 'Question not found.',
    'anamnesis.forbidden.notOwner': 'You do not have access to this anamnesis.',
    'anamnesis.forbidden.general': 'General anamneses cannot be edited.',
    'anamnesis.invalidQuestionType': 'Invalid or unsupported question type.',
    'anamnesis.alreadyLinked': 'This anamnesis is already linked to this student.',
    'anamnesis.hasStudentLinks': 'This anamnesis is linked to students. Please create a new version before editing.',
    'anamnesis.response.notFound': 'No response found for this anamnesis.',
    'anamnesis.response.alreadySubmitted': 'This anamnesis has already been submitted.',
    'anamnesis.response.submittedByStudent': 'The student has already submitted this anamnesis.',
    'anamnesis.response.filledByAnotherTrainer': 'This anamnesis was filled in by another trainer.',
    'anamnesis.response.notAwaitingConfirmation': 'This anamnesis is not awaiting confirmation.',
    'anamnesis.notLinkedToStudent': 'This anamnesis is not linked to your profile.',
    'anamnesis.invalidCondition': 'Invalid condition for the parent question type.',
    'anamnesis.parentNotEligible': 'Only dichotomous, single choice, or multiple choice questions can be parent questions.',
    'anamnesis.parentMustBeSameSection': 'The parent question must be in the same section.',
    'anamnesis.parentTypeLocked': 'The question type cannot be changed because conditional child questions are linked.',
    'anamnesis.conditionReferencesRemovedOption': 'Cannot remove an option referenced by a conditional question.',
    'anamnesis.conditionalDepthExceeded': 'Conditional questions cannot be chained — only one level of depth is allowed.',

    // AI assistant
    'ai.trainerNotFound': 'Trainer profile not found.',
    'ai.conversationNotFound': 'Conversation not found.',
    'ai.rateLimited': 'Too many messages sent. Please wait a moment.',
    'ai.modelError': 'The assistant is temporarily unavailable. Please try again.',
    'ai.overloaded': 'The assistant is currently overloaded. Please try again in a moment.',
    'ai.exerciseTemplateNotOwned': 'Exercise template does not belong to you.',
    'ai.trainingTemplateNotOwned': 'Training template does not belong to you.',
    'ai.unavailable': 'The assistant is not available right now. Please try again later.',
    'ai.responseTooLong': 'The response was too long. Try splitting your request into smaller parts.',
    'ai.confirmationRequired': 'Please confirm the action before I run it.',
    'ai.timeout': 'The assistant took too long to respond. Try again or split your request into smaller parts.',
    'ai.toolDisabled': 'This action is temporarily disabled. Please make the change manually.',

    // Gamification
    'gamification.config.notFound': 'Gamification configuration not found.',
    'gamification.action.disabled': 'This action has been disabled by your trainer.',
    'gamification.ranking.insufficientStudents': 'At least 3 active students (last 14 days) are required to display the ranking.',
    'gamification.globalRankingRemoved': 'The global ranking has been discontinued. Use challenges instead.',
    'consistencyRanking.config.invalid': 'Invalid ranking configuration.',
    'consistencyRanking.pause.weekNotEditable': 'This week is closed or more than 12 weeks ahead, so it cannot be paused or resumed.',
    'consistencyRanking.season.notFound': 'Season not found.',
    'consistencyRanking.target.notEditable': 'This target can only be lowered during the running week, down to zero and never above the original target.',

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

    // Nutrition
    'nutrition.invite.selfInvite': 'You cannot add yourself as a patient.',
    'nutrition.invite.alreadyLinked': 'This patient is already linked to you.',
    'nutrition.invite.alreadyPending': 'There is already a pending invite for this email.',
    'nutrition.invite.notFound': 'Invite not found.',
    'nutrition.invite.notPending': 'This invite is no longer pending.',
    'nutrition.invite.resendCooldown': 'Please wait a bit before resending this invite.',
    'nutrition.invite.maxSends': 'You reached the resend limit for this invite.',
    'nutrition.invite.dailyLimit': 'You reached the daily invite limit. Try again later.',
    'nutrition.invite.emailSendFailed': 'Could not send the invite email. Please try again.',
    'nutrition.invite.accountDeactivated': 'This account is deactivated.',
    'nutrition.invite.expired': 'This invite has expired. Ask the nutritionist to resend it.',
    'nutrition.patient.notFound': 'Patient not found.',
    'nutrition.plan.notFound': 'Meal plan not found.',
    'nutrition.plan.noMeals': 'Add at least one meal before publishing the plan.',
    'nutrition.plan.noKcalTarget': 'Set the calorie target before publishing the plan.',
    'nutrition.meal.notFound': 'Meal not found.',
    'nutrition.meal.maxOptions': 'Each meal can have at most 3 options.',
    'nutrition.meal.firstOptionRequired': 'The first option of a meal cannot be removed.',
    'nutrition.meal.invalidOrder': 'The meal list must contain every meal of the plan exactly once.',
    'nutrition.option.notFound': 'Meal option not found.',
    'nutrition.item.notFound': 'Item not found.',
    'nutrition.substitute.notFound': 'Substitute not found.',
    'nutrition.substitute.cannotEquate': 'The original item or this food has none of the nutrient used for the swap, so they cannot be equated.',
    'nutrition.substitute.quantityTooLarge': 'The equivalent quantity of this food is too large.',
    'nutrition.day.outOfRange': 'This day is outside the period in which the plan can be logged.',
    'nutrition.swap.notAllowed': 'This swap was not released for this item.',
    'nutrition.food.notFound': 'Food not found.',
    'nutrition.foodGroup.notFound': 'Food group not found.',

    // Advanced techniques
    'advancedTechnique.notFound': 'Advanced technique not found.',
    'advancedTechnique.forbidden': 'System advanced techniques cannot be changed.',
    'advancedTechnique.invalidSelection': 'One or more selected advanced techniques are invalid.',

    // Dashboard
    'dashboard.invalidDateRange': 'Invalid date range (dateFrom must be before dateTo).',
    'dashboard.windowTooLarge': 'Date window exceeds the 365-day maximum.',

    // Superset / bi-set
    'exercise.supersetMembershipInvalid': 'Superset exercises must be contiguous in the training sequence.',
    'exercise.supersetMinMembers': 'A superset requires at least 2 exercises.',
    'exercise.supersetMaxMembers': 'A superset cannot have more than 6 exercises.',
    'exercise.alreadyInSuperset': 'One or more exercises already belong to a superset group.',
    'exercise.supersetGroupNotFound': 'Superset group not found or has no active members.',

    // Exercise last performance
    'exercise.notFound': 'Exercise not found.',
    'exercise.notYours': 'This exercise does not belong to your protocol.',

    // Exercise intensity
    'exercise.intensityRequiresCardio': 'Intensity can only be set for cardio exercises.',

    // Substitute exercises
    'exercise.substituteSameTraining': 'The substitute exercise must belong to the same training as the principal.',
    'exercise.substituteCannotChain': 'A substitute exercise cannot itself have substitutes (no chaining allowed).',
    'exercise.substituteCannotBeInSuperset': 'Exercises belonging to a superset group cannot be used as substitutes.',
    'exercise.substitutedAlready': 'This exercise is already a substitute for another exercise.',
    'exercise.substituteNotFound': 'Substitute not found.',
    'exercise.logAlreadySubstituted': 'This exercise log has already been substituted.',
    'exercise.undoHasSets': 'Cannot undo swap: sets have already been logged for this exercise.',
    'exercise.undoNotSubstitute': 'This log is not a substitute exercise. Use this endpoint only to undo swaps.',

    // Subscription plans
    'subscription.planNotFound': 'Subscription plan not found.',
    'subscription.planArchived': 'This plan is archived and cannot be used.',
    'subscription.bothDiscountsSet': 'Set only one discount type: percentage or fixed amount.',
    'subscription.discountExceedsPrice': 'The discount cannot exceed the plan price.',
    'subscription.notFound': 'Subscription not found.',
    'subscription.cannotEditCancelled': 'Cannot edit a cancelled subscription.',
    'subscription.paymentNotFound': 'Subscription payment not found.',
    'subscription.paymentAlreadyPaid': 'This payment is already paid. Revert it to pending before changing or voiding it.',
    'subscription.paymentCancelled': 'This payment was voided and cannot be changed.',
    'subscription.cancelled': 'This subscription is cancelled.',
    'subscription.alreadyActive': 'This student already has an active subscription.',
    'subscription.cycleNotDue': 'The next billing cycle is not available yet.',
    'subscription.paymentConflict': 'The payment was changed by another operation. Refresh and try again.',
    'subscription.cycleAlreadyExists': 'This billing cycle already exists.',
    'subscription.invalidAmount': 'Invalid amount. Use at most two decimal places and no more than 99,999,999.99.',
    'subscription.invalidPaidAt': 'Invalid payment date: it cannot be in the future or more than a year before the subscription start.',

    // Platform plan (SaaS gating)
    'platformPlan.studentCapExceeded': 'You have reached the student limit for your plan. Upgrade to unlock more slots.',
    'platformPlan.aiNotAvailable': 'iArnold is not available on your plan. Upgrade to Pro or higher.',
    'platformPlan.aiActionsExceeded': 'You have reached the monthly iArnold action limit for this student.',
    'platformPlan.brandingNotAvailable': 'Brand customization is not available on your plan.',
    'platformPlan.championshipsNotAvailable': 'Championships are not available on your plan.',
    'platformPlan.studentBlockedOnPlan': 'This student is blocked by your current plan limit. Upgrade to reactivate.',
    'platformPlan.upgradeRequired': 'Upgrade your plan to access this feature.',
    'platformPlan.checkoutFailed': 'Could not start checkout. Please try again.',
    'platformPlan.paymentOverdue': 'There is an overdue payment. Please settle it to keep your plan active.',
    'platformPlan.invalidTier': 'Invalid plan.',
    'platformPlan.alreadyOnTier': 'You are already on this plan.',

    // Asaas webhook (machine-to-machine — message rarely surfaced to a human, but
    // must not read as a user auth error when someone is debugging the integration)
    'webhook.invalidSecret': 'Invalid or missing webhook signature.',

    // Bulk protocol creation
    'protocol.trainingTemplateNotOwned': 'One or more training templates do not belong to your profile.',
    'protocol.exerciseTemplateNotOwned': 'One or more exercise templates do not belong to your profile.',

    // Admin manager (backoffice)
    'admin.queryTimeout': 'The query took too long. Narrow the search and try again.',
    'admin.userNotFound': 'User not found.',
    'admin.protocolNotFound': 'Protocol not found.',
    'admin.sessionNotFound': 'Workout session not found.',
    // Tutorials ("How to use")
    'tutorial.notFound': 'Tutorial not found.',
    'tutorial.invalidVideoType': 'Unsupported video format. Use MP4, WebM or MOV.',
    'tutorial.videoTooLarge': 'The video exceeds the 500 MB size limit.',
    'tutorial.invalidVideoKey': 'Invalid video file. Please upload the video again.',
    'tutorial.invalidOrder': 'The new tutorial order is invalid.',

    // Exercise video upload
    'exerciseVideo.invalidFileKey': 'Invalid video file. Please upload the video again.',

    // Video library
    'video.notFound': 'Video not found.',
    'video.invalidUrl': 'Invalid URL. Please use a valid http(s) address.',
    'video.invalidCategory': 'Invalid category.',
    'video.invalidBodySegment': 'Invalid body segment.',
    'video.titleRequired': 'Video title is required.',
    'video.tagsExceeded': 'Maximum number of tags exceeded.',

    // Trainer invite (closed beta)
    'invite.notFound': 'Invite not found or invalid code.',
    'invite.expired': 'This invite has expired.',
    'invite.revoked': 'This invite has been revoked.',
    'invite.alreadyAccepted': 'This invite has already been used.',
    'invite.emailMismatch': 'This invite is bound to a different email address.',
    'invite.required': 'An invite is required to access this feature during the closed beta.',
    'invite.alreadyActiveForEmail': 'This email already has an active invite.',
    'trainerInvite.accountExists': 'An account already exists for this email. Sign in and redeem the invite.',

    // Student invite (trainer -> prospective student)
    'studentInvite.notFound': 'Invite not found.',
    'studentInvite.notPending': 'This invite is no longer pending.',
    'studentInvite.resendCooldown': 'Please wait a bit before resending this invite.',
    'studentInvite.resendLimit': 'You have reached the resend limit for this invite.',
    'studentInvite.alreadyPending': 'There is already a pending invite for this email.',
    'studentInvite.dailyLimit': 'You have reached the daily invite limit. Please try again later.',
    'studentInvite.emailSendFailed': 'We could not send the invite email. Please try again.',
    'student.accountDeactivated': 'This student account is deactivated.',

    // Email verification
    'emailVerification.invalidCode': 'Invalid verification code.',
    'emailVerification.codeExpired': 'The verification code has expired. Request a new one.',
    'emailVerification.tooManyAttempts': 'Too many incorrect attempts. Request a new code.',
    'emailVerification.alreadyVerified': 'Your email is already verified.',
    'emailVerification.resendCooldown': 'Please wait a moment before requesting a new code.',
    'emailVerification.userNotFound': 'User not found.',
    'emailVerification.dailyLimit': 'You have requested too many codes today. Please try again later.',
    'emailVerification.sendFailed': 'We could not send the verification email. Please try again.',

    // Password reset
    'auth.email.required': 'Email is required.',
    'passwordReset.invalidCode': 'Invalid or expired code. Request a new one.',
    'passwordReset.codeRequired': 'The reset code is required.',
    'passwordReset.weakPassword': 'Password must be at least 8 characters.',
    'passwordReset.passwordMismatch': 'Passwords do not match.',

    // Postal code lookup (legacy-coded errors from address-service)
    'legacy.POSTAL_CODE_REQUIRED': 'Postal code is required.',
    'legacy.INVALID_POSTAL_CODE_FORMAT': 'Invalid postal code. It must have 8 digits.',
    'legacy.POSTAL_CODE_NOT_FOUND': 'Postal code not found.',
    'legacy.POSTAL_CODE_API_ERROR': 'Could not look up the postal code right now. Please try again shortly.',
  },

  // iArnold progress texts streamed to the client (SSE `status` events)
  ai: {
    status: {
      analyzing: 'Analyzing your request',
      executing: 'Running action',
    },
    toolStatus: {
      import_from_template: 'Importing protocol from template',
      add_training_to_protocol: 'Adding training to protocol',
      create_exercise_template: 'Creating exercise',
      create_training_template: 'Creating training',
      create_protocol_template: 'Creating routine',
      update_protocol_template: 'Editing protocol template',
      update_training_template: 'Editing training template',
      update_exercise_template: 'Editing exercise template',
      update_protocol: 'Editing protocol',
      update_training: 'Editing training',
      update_exercise: 'Editing exercise',
      add_exercises_to_training: 'Adding exercises to training',
      reorder_exercises_in_training: 'Reordering exercises',
      get_student_performance: 'Checking student performance',
      search_exercise_library: 'Searching exercise library',
    },
  },

  notes: {
    autoCompleted24h: '[Workout auto-completed after 24h of inactivity]',
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

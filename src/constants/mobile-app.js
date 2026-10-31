export const MobilePlatform = Object.freeze({
  IOS: 'ios',
  ANDROID: 'android',
});

export const mobilePlatformValues = Object.freeze(Object.values(MobilePlatform));

export const MobileAppEnv = Object.freeze({
  APP_ORIGINS: 'MOBILE_APP_ORIGINS',
  MIN_VERSIONS: 'APP_MIN_VERSIONS',
  FCM_SERVICE_ACCOUNT: 'FCM_SERVICE_ACCOUNT_JSON',
});

export const DEVICE_TOKEN_MAX_LENGTH = 512;
export const DEVICE_APP_ID_MAX_LENGTH = 255;
export const APP_VERSION_FIELD_MAX_LENGTH = 255;

export const PushEventType = Object.freeze({
  WORKOUT_COMPLETED: 'workout_completed',
  ANAMNESIS_SUBMITTED: 'anamnesis_submitted',
});

export const FCM_APP_NAME = 'teufit-trainer-push';

export const FcmStaleTokenCode = Object.freeze({
  NOT_REGISTERED: 'messaging/registration-token-not-registered',
  INVALID_TOKEN: 'messaging/invalid-registration-token',
});

export const fcmStaleTokenCodes = Object.freeze(Object.values(FcmStaleTokenCode));

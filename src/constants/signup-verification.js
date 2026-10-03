// Code length, TTL, attempts, resend cooldown and daily cap are shared with the
// authenticated verify-email flow: see ./email-verification.js.

export const SignupStatus = Object.freeze({
  PENDING_VERIFICATION: 'pending_verification',
});

// A pending signup with no activity (signup / resend) for this long is purged.
// Its codes are all older than the daily window by then, so purging never
// resets the per-email code cap.
export const PENDING_SIGNUP_STALE_MS = 24 * 60 * 60 * 1000;

// "You already have an account" emails: at most one per address per window.
export const EXISTING_ACCOUNT_NOTICE_THROTTLE_MS = 15 * 60 * 1000;

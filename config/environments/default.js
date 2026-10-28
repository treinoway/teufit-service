import { parseBool } from '../../src/helpers/env.js';

// Comma-separated list → normalized (trimmed, lowercased), non-empty emails.
// Used to parse BETA_TESTER_EMAILS below.
function parseEmailAllowlist(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export default {
  auth: {
    accessTokenTtlSeconds: 60 * 15, // 15 minutes
    refreshTokenTtlSeconds: 60 * 60 * 24 * 7, // 7 days
    // Returning the reset code in the forgot-password body defeats the email
    // proof. Only development and test turn this on; never staging/production.
    exposeResetTokenInResponse: false,
    // Per-email silent throttle on issuing reset codes (a throttled request
    // still gets the uniform 200, it just sends nothing).
    passwordResetCooldownMs: 60 * 1000,
    passwordResetMaxPerHour: 5,
    // Temporary: accepts the old mobile body {token, password, passwordConfirmation}
    // on POST /auth/reset-password. Remove 1 day after the mobile release that
    // sends {email, code}. Kill switch: LEGACY_RESET_TOKEN_ENABLED=false.
    legacyResetToken: {
      enabled: parseBool(process.env.LEGACY_RESET_TOKEN_ENABLED, true),
      // One global bucket (constant key): a code without an email is matchable against any user.
      rateLimit: { max: 30, timeWindow: '1 minute' },
      rateLimitHourly: { max: 100, timeWindow: '1 hour' },
      // Process-local: opens after maxInvalid wrong codes inside windowMs and stays open until restart.
      circuitBreaker: { maxInvalid: 30, windowMs: 3600000 },
    },
  },
  sentry: {
    // Optional — all Sentry calls are no-ops when DSN is absent.
    dsn: process.env.SENTRY_DSN || null,
    environment: process.env.SENTRY_ENVIRONMENT || 'beta',
    // Fraction of requests traced for performance (0..1). Default 0.1 (10%) keeps
    // prod within Sentry quota; set SENTRY_TRACES_SAMPLE_RATE=1.0 in staging for
    // full traces, or =0 to disable tracing in an environment. Empty/unset → 0.1.
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
  },
  asaas: {
    apiKey: process.env.ASAAS_API_KEY,
    webhookSecret: process.env.ASAAS_WEBHOOK_SECRET,
    env: process.env.ASAAS_ENV || 'sandbox',
  },
  web: {
    // Used to build the trainer-invite magic link: `${baseUrl}/invite?code=...`
    baseUrl: process.env.WEB_BASE_URL || 'https://teufit.com.br',
  },
  stores: {
    // Store listing links embedded in student emails. Both apps are published, so the
    // defaults are the live listings; the env overrides stay as an escape hatch for
    // changing a link without a deploy.
    //
    // The App Store link deliberately uses the id-only form instead of
    // `/app/<slug>/id<id>`: Apple resolves by numeric id and ignores the slug, and the
    // current listing slug is `teufit-production`, which would render a stale name in
    // every email. Apple id confirmed via
    // https://itunes.apple.com/lookup?bundleId=br.com.teufit.app&country=br (trackId).
    appStoreUrl: process.env.APP_STORE_URL || 'https://apps.apple.com/br/app/id6809516404',
    playStoreUrl: process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=br.com.teufit.app',
  },
  betaInviteGate: {
    // Emergency kill-switch for the /become-trainer beta gate — set
    // BETA_INVITE_GATE_ENABLED=false to disable without a deploy. Parsed
    // case/whitespace-tolerantly since this is hand-typed into a Railway
    // dashboard; default true preserves today's default-enabled behavior.
    enabled: parseBool(process.env.BETA_INVITE_GATE_ENABLED, true),
    // Allowlist of emails that skip the invite gate entirely (for QA/testing).
    // Comma-separated, normalized to trimmed lowercase. Default: none exempt.
    testerEmails: parseEmailAllowlist(process.env.BETA_TESTER_EMAILS),
  },
  rateLimit: {
    global: {
      max: 100,
      timeWindow: '1 minute',
    },
    globalPerUser: {
      max: 20,
      timeWindow: '1 minute',
    },
    auth: {
      waitlist: {
        max: 20,
        timeWindow: '1 hour',
      },
      // Per IP, loose enough for carrier-grade NAT / gym wifi; the per-account
      // bound is loginPerEmail.
      login: {
        max: 30,
        timeWindow: '1 minute',
      },
      // Keyed by the (normalized) email in the body, on top of login.
      loginPerEmail: {
        max: 10,
        timeWindow: '15 minutes',
      },
      changePassword: {
        max: 5,
        timeWindow: '1 minute',
      },
      forgotPassword: {
        max: 20,
        timeWindow: '1 hour',
      },
      // Keyed by the (normalized) email in the body, on top of forgotPassword.
      forgotPasswordPerEmail: {
        max: 3,
        timeWindow: '1 hour',
      },
      resetPassword: {
        max: 10,
        timeWindow: '1 minute',
      },
      verifyEmail: {
        max: 10,
        timeWindow: '1 minute',
      },
      resendEmailVerification: {
        max: 5,
        timeWindow: '1 hour',
      },
      // Public signup endpoints, IP-keyed. Kept loose enough for carrier-grade
      // NAT (many mobile users behind one IP); the real per-email bounds are the
      // DB-backed code cooldown / daily cap / attempts (src/constants/email-verification.js).
      signup: {
        max: 20,
        timeWindow: '1 hour',
      },
      signupVerify: {
        max: 30,
        timeWindow: '15 minutes',
      },
      // Keyed by the (normalized) email in the body, on top of signupVerify.
      signupVerifyPerEmail: {
        max: 10,
        timeWindow: '15 minutes',
      },
      signupResend: {
        max: 10,
        timeWindow: '1 hour',
      },
      // POST /auth/signup/invite: public, the TF- code (~50 bits) is the only
      // gate, so this stays tighter than signupVerify but loose enough for CGNAT.
      signupInvite: {
        max: 20,
        timeWindow: '15 minutes',
      },
    },
    postalCode: {
      max: 10,
      timeWindow: '1 minute',
    },
    // Public (unauthenticated), IP-keyed by default — no keyGenerator override,
    // same as auth.* above.
    invite: {
      preview: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    user: {
      becomeTrainer: {
        max: 3,
        timeWindow: '1 hour',
      },
      becomeNutritionist: {
        max: 3,
        timeWindow: '1 hour',
      },
      uploadAvatar: {
        max: 5,
        timeWindow: '1 minute',
      },
      redeemInvite: {
        max: 10,
        timeWindow: '1 hour',
      },
      deleteAccount: {
        max: 3,
        timeWindow: '1 hour',
      },
    },
    trainer: {
      inviteStudent: {
        max: 20,
        timeWindow: '1 minute',
      },
      resendStudentInvite: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    platformPlan: {
      checkout: { max: 5, timeWindow: '1 minute' },
      cancel: { max: 5, timeWindow: '1 minute' },
      change: { max: 5, timeWindow: '1 minute' },
    },
  },
};

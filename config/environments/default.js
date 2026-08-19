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
        max: 3,
        timeWindow: '1 hour',
      },
      login: {
        max: 5,
        timeWindow: '1 minute',
      },
      changePassword: {
        max: 5,
        timeWindow: '1 minute',
      },
      forgotPassword: {
        max: 3,
        timeWindow: '1 hour',
      },
      resetPassword: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    postalCode: {
      max: 10,
      timeWindow: '1 minute',
    },
    user: {
      getMe: {
        max: 30,
        timeWindow: '1 minute',
      },
      updateProfile: {
        max: 10,
        timeWindow: '1 minute',
      },
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
    },
    trainer: {
      searchStudents: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
    import: {
      primecoachingPreview: {
        max: 3,
        timeWindow: '1 minute',
      },
    },
    trainingProtocol: {
      create: {
        max: 20,
        timeWindow: '1 minute',
      },
      list: {
        max: 60,
        timeWindow: '1 minute',
      },
      getById: {
        max: 60,
        timeWindow: '1 minute',
      },
      update: {
        max: 20,
        timeWindow: '1 minute',
      },
      delete: {
        max: 10,
        timeWindow: '1 minute',
      },
      importFromTemplate: {
        max: 10,
        timeWindow: '1 minute',
      },
      createWithTrainings: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    trainingProtocolTemplate: {
      create: {
        max: 20,
        timeWindow: '1 minute',
      },
      list: {
        max: 60,
        timeWindow: '1 minute',
      },
      getById: {
        max: 60,
        timeWindow: '1 minute',
      },
      update: {
        max: 20,
        timeWindow: '1 minute',
      },
      delete: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    dietProtocol: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      delete: { max: 10, timeWindow: '1 minute' },
      importFromTemplate: { max: 10, timeWindow: '1 minute' },
    },
    dietProtocolTemplate: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      delete: { max: 10, timeWindow: '1 minute' },
    },
    nutritionistPatient: {
      link: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      unlink: { max: 10, timeWindow: '1 minute' },
      metabolicProfile: { max: 20, timeWindow: '1 minute' },
    },
    food: {
      search: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      groups: { max: 60, timeWindow: '1 minute' },
    },
    dietMeal: {
      create: { max: 30, timeWindow: '1 minute' },
      update: { max: 30, timeWindow: '1 minute' },
      delete: { max: 20, timeWindow: '1 minute' },
    },
    dietFoodItem: {
      create: { max: 30, timeWindow: '1 minute' },
      update: { max: 30, timeWindow: '1 minute' },
      delete: { max: 20, timeWindow: '1 minute' },
    },
    subscriptionPlan: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      archive: { max: 10, timeWindow: '1 minute' },
      unarchive: { max: 10, timeWindow: '1 minute' },
    },
    studentSubscription: {
      assign: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      getActive: { max: 60, timeWindow: '1 minute' },
      getById: { max: 60, timeWindow: '1 minute' },
      cancel: { max: 10, timeWindow: '1 minute' },
    },
    subscriptionPayment: {
      create: { max: 20, timeWindow: '1 minute' },
      list: { max: 60, timeWindow: '1 minute' },
      update: { max: 20, timeWindow: '1 minute' },
      markPaid: { max: 30, timeWindow: '1 minute' },
      markPending: { max: 30, timeWindow: '1 minute' },
      delete: { max: 10, timeWindow: '1 minute' },
    },
    platformPlan: {
      get: { max: 30, timeWindow: '1 minute' },
      checkout: { max: 5, timeWindow: '1 minute' },
      cancel: { max: 5, timeWindow: '1 minute' },
      change: { max: 5, timeWindow: '1 minute' },
    },
    trainerDashboard: {
      get: { max: 60, timeWindow: '1 minute' },
    },
  },
};

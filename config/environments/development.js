import { parseBool } from '../../src/helpers/env.js';

export default {
    auth: {
      exposeResetTokenInResponse: true,
      // Manual testing re-requests codes freely.
      passwordResetCooldownMs: 0,
      passwordResetMaxPerHour: 1000,
    },
    // Sentry desligado em dev mesmo com SENTRY_DSN presente no .env: erros de
    // desenvolvimento (import quebrado, watcher reiniciando) viram issue no
    // projeto de verdade, e o Sentry.init() carrega auto-instrumentação OTel
    // que custa ~33MB de RSS. Para depurar a integração localmente, defina
    // SENTRY_FORCE_LOCAL=true.
    sentry: {
      dsn: parseBool(process.env.SENTRY_FORCE_LOCAL, false)
        ? process.env.SENTRY_DSN || null
        : null,
    },
    // Mesma regra do Sentry: Rollbar desligado em dev, a não ser que
    // ROLLBAR_FORCE_LOCAL=true (para testar a integração localmente).
    rollbar: {
      accessToken: parseBool(process.env.ROLLBAR_FORCE_LOCAL, false)
        ? process.env.ROLLBAR_ACCESS_TOKEN || null
        : null,
    },
    // Langfuse desligado em dev, a não ser que LANGFUSE_FORCE_LOCAL=true e as duas chaves existam.
    langfuse: {
      enabled: parseBool(process.env.LANGFUSE_FORCE_LOCAL, false)
        && Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim()),
    },
    rateLimit: {
        global: { max: 10000, timeWindow: '1 minute' },
        globalPerUser: { max: 10000, timeWindow: '1 minute' },
        auth: {
          waitlist: { max: 1000, timeWindow: '1 minute' },
          login: { max: 1000, timeWindow: '1 minute' },
          loginPerEmail: { max: 1000, timeWindow: '1 minute' },
          changePassword: { max: 1000, timeWindow: '1 minute' },
          forgotPassword: { max: 1000, timeWindow: '1 minute' },
          forgotPasswordPerEmail: { max: 1000, timeWindow: '1 minute' },
          resetPassword: { max: 1000, timeWindow: '1 minute' },
          verifyEmail: { max: 1000, timeWindow: '1 minute' },
          resendEmailVerification: { max: 1000, timeWindow: '1 minute' },
          signup: { max: 1000, timeWindow: '1 minute' },
          signupVerify: { max: 1000, timeWindow: '1 minute' },
          signupVerifyPerEmail: { max: 1000, timeWindow: '1 minute' },
          signupResend: { max: 1000, timeWindow: '1 minute' },
          signupInvite: { max: 1000, timeWindow: '1 minute' },
        },
        postalCode: {
          max: 1000,
          timeWindow: '1 minute',
        },
        invite: {
          preview: {
            max: 1000,
            timeWindow: '1 minute',
          },
        },
        user: {
            becomeTrainer: {
              max: 1000,
              timeWindow: '1 hour',
            },
            uploadAvatar: {
              max: 1000,
              timeWindow: '1 minute',
            },
            redeemInvite: {
              max: 1000,
              timeWindow: '1 hour',
            },
            deleteAccount: {
              max: 1000,
              timeWindow: '1 hour',
            },
          },
        trainer: {
          inviteStudent: { max: 1000, timeWindow: '1 minute' },
          resendStudentInvite: { max: 1000, timeWindow: '1 minute' },
        },
        nutritionist: {
          invitePatient: { max: 1000, timeWindow: '1 minute' },
          resendPatientInvite: { max: 1000, timeWindow: '1 minute' },
        },
        exerciseTemplate: {
          create: { max: 1000, timeWindow: '1 minute' },
          list: { max: 1000, timeWindow: '1 minute' },
          getById: { max: 1000, timeWindow: '1 minute' },
          update: { max: 1000, timeWindow: '1 minute' },
          delete: { max: 1000, timeWindow: '1 minute' },
        },
        exercise: {
          create: { max: 1000, timeWindow: '1 minute' },
          createFromTemplate: { max: 1000, timeWindow: '1 minute' },
          list: { max: 1000, timeWindow: '1 minute' },
          getById: { max: 1000, timeWindow: '1 minute' },
          update: { max: 1000, timeWindow: '1 minute' },
          delete: { max: 1000, timeWindow: '1 minute' },
        },
      },
};

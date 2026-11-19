import 'dotenv/config';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import { SerializerSelector } from '@fastify/fast-json-stringify-compiler';
import config from '../config/index.js';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifySession from '@fastify/session';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import { registerRateLimit } from '../src/helpers/register-rate-limit.js';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { prisma } from '../src/db.js';
import { rollbar } from '../src/rollbar.js';
import { buildErrorPayload, normalizeError, normalizeErrorResponsePayload } from '../src/errors/index.js';
import { translate } from '../src/i18n/index.js';
import { parseBool } from '../src/helpers/env.js';
import { createErrorSerializerCacheFactory } from '../src/helpers/error-serializer-cache.js';
import { authRoutes } from './routes/auth-route.js';
import { trainerRoutes } from './routes/trainer-route.js';
import { nutritionistRoutes } from './routes/nutritionist-route.js';
import { userRoutes } from './routes/user-route.js';
import { trainerInviteRoutes, trainerInvitePreviewRoutes } from './routes/trainer-invite-route.js';
import { studentInviteRoutes } from './routes/student-invite-route.js';
import { addressRoutes } from './routes/address-route.js';
import { trainingProtocolTemplateRoutes } from './routes/training-protocol-template-route.js';
import { trainingProtocolRoutes } from './routes/training-protocol-route.js';
import { trainingTemplateRoutes } from './routes/training-template-route.js';
import { trainingRoutes } from './routes/training-route.js';
import { exerciseTemplateRoutes } from './routes/exercise-template-route.js';
import { exerciseRoutes } from './routes/exercise-route.js';
import { advancedTechniqueRoutes } from './routes/advanced-technique-route.js';
import { workoutSessionRoutes } from './routes/workout-session-route.js';
import { anamnesisRoutes } from './routes/anamnesis-route.js';
import { adminAnamnesisRoutes } from './routes/admin-anamnesis-route.js';
import { adminVideoRoutes } from './routes/admin-video-route.js';
import { videoRoutes } from './routes/video-route.js';
import { adminTutorialRoutes } from './routes/admin-tutorial-route.js';
import { tutorialRoutes } from './routes/tutorial-route.js';
import { exerciseVideoRoutes } from './routes/exercise-video-route.js';
import { aiRoutes } from './routes/ai-route.js';
import { trainerBrandingRoutes } from './routes/trainer-branding-route.js';
import { gamificationRoutes } from './routes/gamification-route.js';
import { challengeRoutes } from './routes/challenge-route.js';
import { workoutsTodayRoutes } from './routes/workouts-today-route.js';
import { nutritionistPatientRoutes } from './routes/nutritionist-patient-route.js';
import { foodRoutes } from './routes/food-route.js';
import { nutritionPlanRoutes } from './routes/nutrition-plan-route.js';
import { nutritionTodayRoutes } from './routes/nutrition-today-route.js';
import { nutritionInviteRoutes } from './routes/nutrition-invite-route.js';
import { studentDashboardRoutes } from './routes/student-dashboard-route.js';
import { subscriptionPlanRoutes } from './routes/subscription-plan-route.js';
import { studentSubscriptionRoutes } from './routes/student-subscription-route.js';
import { subscriptionPaymentRoutes } from './routes/subscription-payment-route.js';
import { trainerBriefingRoutes } from './routes/trainer-briefing-route.js';
import { consistencyRankingRoutes } from './routes/consistency-ranking-route.js';
import { adminConsistencyRankingRoutes } from './routes/admin-consistency-ranking-route.js';
import { trainerDashboardRoutes } from './routes/trainer-dashboard-route.js';
import { trainerFinanceRoutes } from './routes/trainer-finance-route.js';
import { professionalRoutes } from './routes/professional-route.js';
import { platformPlanRoutes } from './routes/platform-plan-route.js';
import { adminTrainerRoutes } from './routes/admin-trainer-route.js';
import { adminManagerRoutes } from './routes/admin-manager-route.js';
import { trainerFeedbackRoutes } from './routes/trainer-feedback-route.js';
import { adminFeedbackRoutes } from './routes/admin-feedback-route.js';
import { studentFeedbackRoutes } from './routes/student-feedback-route.js';
import { createAdminPrisma } from '../src/db-admin.js';
import { getLlmProvider } from '../src/llm/index.js';
import { createAiTracer } from '../src/observability/ai-tracer.js';
import { adminAiUsageRoutes } from './routes/admin-ai-usage-route.js';
import { adminDebugRoutes } from './routes/admin-debug-route.js';
import { asaasWebhookRoutes } from './routes/asaas-webhook-route.js';
import { startBriefingCron } from '../src/jobs/briefing-cron.js';
import { startSubscriptionCycleCron } from '../src/jobs/subscription-cycle-cron.js';
import { startConsistencyCloseCron } from '../src/jobs/consistency-close-cron.js';
import { startStudentFeedbackCron } from '../src/jobs/student-feedback-cron.js';
import { authenticate } from './hooks/auth-hook.js';
import { languageOnRequestHook, applyLabelsPreSerializationHook } from './hooks/i18n-hook.js';
import { createSignedFileHook } from './hooks/signed-file-hook.js';
import s3BucketHandler from '../src/config/s3-bucket-handler.js';
import emailHandler from '../src/config/email-handler.js';
import { resolveExerciseVideoUrl } from '../src/helpers/exercise-video-key.js';
import { healthRoutes } from './routes/health-route.js';
import { checkLlmConfiguration } from '../src/llm/config.js';
import { assertAsaasWebhookSecretConfigured } from '../src/helpers/asaas-webhook-helpers.js';

// Sentry is initialised in the `./instrument.js` preload (loaded via
// `node --import ./instrument.js`), which MUST run before this module so OpenTelemetry
// can patch http/pg/fastify for performance tracing. We only consume Sentry here
// (captureException in the error handler below); it is a no-op when SENTRY_DSN is unset.

/**
 * Translate the `message` field of a normalized error payload in place.
 * Only translates when a language is available and the payload has a messageCode.
 * Used in the error-normalizing preSerialization hook to cover the code path where
 * Fastify's built-in error handlers (e.g. 404) bypass setErrorHandler.
 *
 * @param {object} payload
 * @param {string | undefined} language
 */
function translateErrorPayloadMessage(payload, language) {
  if (!language || !payload?.messageCode) return;
  payload.message = translate('errors', payload.messageCode, language, {
    fallbackValue: payload.message,
  });
}

// Decorates the isolated read-only admin client (injected override or built from config) and closes it on shutdown.
function decorateAdminDb(fastify, injectedAdminDb) {
  const adminDb = injectedAdminDb ?? createAdminPrisma({
    connectionString: config.adminDb.url,
    max: config.adminDb.poolMax,
    statementTimeoutMs: config.adminDb.statementTimeoutMs,
  });
  fastify.decorate('adminDb', adminDb);
  if (injectedAdminDb) return;
  fastify.addHook('onClose', async () => {
    await adminDb.$disconnect();
  });
}

// Decorates the iArnold tracer (injected override or built from config) and flushes it on shutdown.
function decorateAiTracer(fastify, injectedTracer) {
  const aiTracer = injectedTracer ?? createAiTracer({ config, logger: fastify.log });
  fastify.decorate('aiTracer', aiTracer);
  fastify.addHook('onClose', async () => {
    await aiTracer.shutdown();
  });
}

// Decorates the single shared LLM provider (injected override or built once); null when the provider is misconfigured.
function decorateLlmProvider(fastify, injectedProvider) {
  let llmProvider = injectedProvider ?? null;
  if (!llmProvider) {
    try {
      llmProvider = getLlmProvider();
    } catch {
      // why: checkLlmConfiguration already logged the misconfiguration; a null provider makes the AI routes answer 503.
      llmProvider = null;
    }
  }
  fastify.decorate('llmProvider', llmProvider);
}

export async function buildServer(options = {}) {
  // Fail fast: once Asaas is actually configured (ASAAS_API_KEY set) in
  // production/staging, boot without a webhook secret must not succeed — otherwise
  // /webhooks/asaas would fail-open and let anyone forge a PAYMENT_CONFIRMED event to
  // upgrade a trainer's tier for free. No-op while Asaas isn't integrated yet, and
  // no-op in development/test even with a sandbox API key configured locally.
  assertAsaasWebhookSecretConfigured({
    env: config.env,
    apiKey: config.asaas.apiKey,
    webhookSecret: config.asaas.webhookSecret,
  });

  const fastify = Fastify({
    logger: options.logger ?? true,
    // Railway runs behind a reverse proxy. Trust it so Fastify correctly detects HTTPS,
    // client IPs, and sets secure cookies consistently.
    trustProxy: true,
    // Error schemas are shared by almost every route; compile each one once instead of
    // once per route × status (~40 MB of heap otherwise). See error-serializer-cache.js.
    schemaController: {
      compilersFactory: {
        buildSerializer: createErrorSerializerCacheFactory(SerializerSelector()),
      },
    },
  });

  checkLlmConfiguration(fastify.log);

  // Make prisma available to route handlers and services that need transactions.
  fastify.decorate('prisma', prisma);
  decorateAdminDb(fastify, options.adminDb);
  decorateAiTracer(fastify, options.aiTracer);
  decorateLlmProvider(fastify, options.llmProvider);

  // 1. Read language header before auth so all handlers see request.language
  fastify.addHook('onRequest', languageOnRequestHook);

  // Echo the request id so web/mobile error reports (Sentry/Crashlytics) correlate with
  // backend logs. Set early so it's present even on error/4xx responses.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  fastify.setErrorHandler((error, request, reply) => {
    const language = request.language;
    const normalizedError = normalizeError(error, language);
    const isServerError = normalizedError.httpStatus >= 500;

    if (isServerError) {
      request.log.error(
        {
          err: error,
          method: request.method,
          url: request.url,
          requestId: request.id,
        },
        'Unhandled server error',
      );

      // Report unexpected server errors to Sentry (no-op when DSN is unset).
      // 4xx client/validation/AppError business errors are intentionally excluded to
      // avoid noise — we only want to be alerted about genuine runtime failures.
      if (config.sentry.dsn) {
        const route = request.routeOptions?.url ?? request.url;
        Sentry.captureException(error, {
          tags: { requestId: request.id, route },
          user: { id: request.user?.id },
        });
      }

      // why: passing the request lets Rollbar attach method, url, scrubbed headers and person (request.user.id).
      if (rollbar) {
        const route = request.routeOptions?.url ?? request.url;
        rollbar.error(error, request, { requestId: request.id, route });
      }
    }

    const payload = buildErrorPayload(normalizedError, { language });
    return reply.status(normalizedError.httpStatus).send(payload);
  });

  // 2. Error-normalizing preSerialization hook — handles statusCode >= 400 paths
  //    that bypass setErrorHandler (e.g. Fastify's built-in 404 handler, raw strings).
  //    /health is excluded: its 503 is a data response (not an error), and normalizing
  //    it would overwrite the health payload fields with error contract fields.
  fastify.addHook('preSerialization', (request, reply, payload, done) => {
    const route = request.routeOptions?.url ?? request.url;
    if (reply.statusCode < 400 || route === '/health') {
      done(null, payload);
      return;
    }

    const language = request.language;

    if (typeof payload === 'string') {
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        done(null, payload);
        return;
      }

      const normalizedPayload = normalizeErrorResponsePayload(parsedPayload, reply.statusCode);
      translateErrorPayloadMessage(normalizedPayload, language);
      done(null, normalizedPayload);
      return;
    }

    const normalizedPayload = normalizeErrorResponsePayload(payload, reply.statusCode);
    translateErrorPayloadMessage(normalizedPayload, language);
    done(null, normalizedPayload);
  });

  // 3. i18n label-applying preSerialization hook — writes *Label siblings for
  //    data responses on routes that use i18nField() / i18nArrayField() in their schemas.
  //    Early-returns for statusCode >= 400 (errors are handled above).
  fastify.addHook('preSerialization', applyLabelsPreSerializationHook);

  fastify.addHook('preSerialization', createSignedFileHook((key) => resolveExerciseVideoUrl(s3BucketHandler, key)));

  // 4. Structured per-request access log (one line per completed request).
  //    Skipped for /health to avoid monitor-polling noise.
  //    Does NOT log bodies, headers, tokens, or passwords.
  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url ?? request.url;
    if (route !== '/health') {
      request.log.info({
        requestId: request.id,
        method: request.method,
        url: route,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        userId: request.user?.id ?? null,
      });
    }
    done();
  });

  // Register CORS support
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Define allowed origins - normalize URLs by removing trailing slashes
  const normalizeUrl = (url) => url?.replace(/\/$/, '') || '';
  const allowedOrigins = isDevelopment 
    ? true // Allow all in development
    : [
        normalizeUrl(process.env.FRONTEND_URL),
        normalizeUrl(process.env.FRONTEND_REDIRECT_URL),
        normalizeUrl(process.env.BACKEND_URL), // Backend URL (e.g., for Swagger UI)
      ].filter(Boolean); // Remove undefined/null values

  await fastify.register(fastifyCors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isDevelopment) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = normalizeUrl(origin);
      
      // Check if origin is in allowed list
      if (allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);
      } else {
        fastify.log.warn(`CORS blocked origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true, // Allow cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  });

  // Register cookie support
  await fastify.register(fastifyCookie);

  // OpenAPI (Swagger) docs
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Treinoway Service API',
        description: 'Backend for Treinoway',
        version: '0.0.1',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
  });

  // Register session support.
  // saveUninitialized:false is required, not tuning: the plugin defaults it to true on
  // top of a Map with no TTL or eviction, so every cookieless request leaked a session
  // (~2.2 KB) until the heap ran out.
  const isDev = process.env.NODE_ENV === 'development';
  await fastify.register(fastifySession, {
    secret: process.env.SESSION_SECRET,
    saveUninitialized: false,
    cookie: {
      secure: !isDev, // use secure cookies in staging/production (HTTPS required)
      httpOnly: true,
      sameSite: isDev ? 'lax' : 'none', // 'lax' for local HTTP, 'none' for staging/production HTTPS
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });

  // Register JWT support (used by mobile clients via Authorization: Bearer <token>)
  const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (!jwtSecret) {
    throw new Error(
      'Missing JWT secret. Set JWT_SECRET (recommended) or SESSION_SECRET (dev fallback) in your environment.',
    );
  }
  await fastify.register(fastifyJwt, {
    secret: jwtSecret,
  });

  // Register Rate Limiting (disabled in test environment)
  if (process.env.NODE_ENV !== 'test') {
    await registerRateLimit(fastify, config.rateLimit);
  }
  
  // Register Multipart support for file uploads
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 1, // Only one file per request
    },
    attachFieldsToBody: false, // Keep file separate from body
  });

  // Register auth routes (public)
  await fastify.register(authRoutes);

  // Register Asaas webhook route (public — no user auth, validated by webhook secret)
  await fastify.register(asaasWebhookRoutes);

  // Health check endpoint (public — registered before the authenticate onRequest hook below).
  await fastify.register(healthRoutes);

  // Trainer invite preview (public — pre-signup code validation; must stay
  // outside the protected block below since that block's onRequest hook
  // cannot be opted out of per-route).
  await fastify.register(trainerInvitePreviewRoutes);

  // Root liveness probe (public)
  fastify.get('/', async () => {
    return { message: "i'm alive" };
  });

  // Register protected routes with authentication (the root rate limiter then keys by user)
  await fastify.register(async (fastify) => {
    // Add authentication hook to all routes in this context
    fastify.addHook('onRequest', authenticate);

    // Register all protected routes
    await fastify.register(trainerRoutes);
    await fastify.register(nutritionistRoutes);
    await fastify.register(userRoutes);
    await fastify.register(trainerInviteRoutes);
    await fastify.register(studentInviteRoutes);
    await fastify.register(addressRoutes);
    await fastify.register(trainingProtocolTemplateRoutes);
    await fastify.register(trainingProtocolRoutes);
    await fastify.register(trainingTemplateRoutes);
    await fastify.register(trainingRoutes);
    await fastify.register(exerciseTemplateRoutes);
    await fastify.register(exerciseRoutes);
    await fastify.register(advancedTechniqueRoutes);
    await fastify.register(workoutSessionRoutes);
    await fastify.register(anamnesisRoutes);
    await fastify.register(adminAnamnesisRoutes);
    await fastify.register(adminVideoRoutes);
    await fastify.register(videoRoutes);
    await fastify.register(adminTutorialRoutes);
    await fastify.register(tutorialRoutes);
    await fastify.register(exerciseVideoRoutes);
    await fastify.register(aiRoutes);
    await fastify.register(trainerBrandingRoutes);
    await fastify.register(gamificationRoutes);
    await fastify.register(challengeRoutes);
    await fastify.register(workoutsTodayRoutes);
    await fastify.register(nutritionistPatientRoutes);
    await fastify.register(foodRoutes);
    await fastify.register(nutritionPlanRoutes);
    await fastify.register(nutritionTodayRoutes);
    await fastify.register(nutritionInviteRoutes);
    await fastify.register(studentDashboardRoutes);
    await fastify.register(subscriptionPlanRoutes);
    await fastify.register(studentSubscriptionRoutes);
    await fastify.register(subscriptionPaymentRoutes);
    await fastify.register(trainerBriefingRoutes);
    await fastify.register(consistencyRankingRoutes);
    await fastify.register(adminConsistencyRankingRoutes);
    await fastify.register(trainerDashboardRoutes);
    await fastify.register(trainerFinanceRoutes);
    await fastify.register(professionalRoutes);
    await fastify.register(platformPlanRoutes);
    await fastify.register(adminTrainerRoutes);
    await fastify.register(adminManagerRoutes);
    await fastify.register(trainerFeedbackRoutes);
    await fastify.register(adminFeedbackRoutes);
    await fastify.register(studentFeedbackRoutes);
    await fastify.register(adminAiUsageRoutes);
    await fastify.register(adminDebugRoutes);
  });

  // Daily briefing cron — enabled only in production or when ENABLE_BRIEFING_CRON=true.
  // Intentionally disabled in test runs and local dev to avoid spurious background work.
  // TODO(scaling): if running multiple instances, gate this with a leader-election or
  // DB advisory lock so only one instance runs the cron.
  const cronEnabled =
    process.env.NODE_ENV === 'production' || parseBool(process.env.ENABLE_BRIEFING_CRON, false);
  if (cronEnabled) {
    startBriefingCron(prisma, fastify.log);
    fastify.log.info('[cron:briefing] daily 22:00 UTC refresh scheduled');
  }

  // Daily subscription cycle generation — same gating as the briefing cron.
  // Idempotent, so safe with multiple instances (see subscription-cycle-service.js).
  const subscriptionCycleCronEnabled =
    process.env.NODE_ENV === 'production' ||
    parseBool(process.env.ENABLE_SUBSCRIPTION_CYCLE_CRON, false);
  if (subscriptionCycleCronEnabled) {
    startSubscriptionCycleCron(prisma, fastify.log);
    fastify.log.info('[cron:subscription-cycles] daily 03:00 America/Sao_Paulo generation scheduled');
  }

  const consistencyCloseCronEnabled =
    process.env.NODE_ENV === 'production' ||
    parseBool(process.env.ENABLE_CONSISTENCY_RANKING_CRON, false);
  if (consistencyCloseCronEnabled) {
    startConsistencyCloseCron(prisma, fastify.log);
    fastify.log.info('[cron:consistency-close] every-15-minutes UTC close scheduled');
  }

  const studentFeedbackCronEnabled =
    process.env.NODE_ENV === 'production' ||
    parseBool(process.env.ENABLE_STUDENT_FEEDBACK_CRON, false);
  if (studentFeedbackCronEnabled) {
    startStudentFeedbackCron(prisma, fastify.log, emailHandler);
    fastify.log.info('[cron:student-feedback] every-15-minutes UTC tick scheduled');
  }

  return fastify;
}

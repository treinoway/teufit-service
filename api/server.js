import 'dotenv/config';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import config from '../config/index.js';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifySession from '@fastify/session';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { prisma } from '../src/db.js';
import { buildErrorPayload, normalizeError, normalizeErrorResponsePayload } from '../src/errors/index.js';
import { translate } from '../src/i18n/index.js';
import { authRoutes } from './routes/auth-route.js';
import { trainerRoutes } from './routes/trainer-route.js';
import { nutritionistRoutes } from './routes/nutritionist-route.js';
import { userRoutes } from './routes/user-route.js';
import { trainerInviteRoutes } from './routes/trainer-invite-route.js';
import { addressRoutes } from './routes/address-route.js';
import { trainingProtocolTemplateRoutes } from './routes/training-protocol-template-route.js';
import { trainingProtocolRoutes } from './routes/training-protocol-route.js';
import { trainingTemplateRoutes } from './routes/training-template-route.js';
import { trainingRoutes } from './routes/training-route.js';
import { exerciseTemplateRoutes } from './routes/exercise-template-route.js';
import { exerciseRoutes } from './routes/exercise-route.js';
import { workoutSessionRoutes } from './routes/workout-session-route.js';
import { anamnesisRoutes } from './routes/anamnesis-route.js';
import { adminAnamnesisRoutes } from './routes/admin-anamnesis-route.js';
import { adminVideoRoutes } from './routes/admin-video-route.js';
import { videoRoutes } from './routes/video-route.js';
import { importPrimeCoachingRoutes } from './routes/import-primecoaching-route.js';
import { aiRoutes } from './routes/ai-route.js';
import { trainerBrandingRoutes } from './routes/trainer-branding-route.js';
import { gamificationRoutes } from './routes/gamification-route.js';
import { challengeRoutes } from './routes/challenge-route.js';
import { workoutsTodayRoutes } from './routes/workouts-today-route.js';
import { nutritionistPatientRoutes } from './routes/nutritionist-patient-route.js';
import { foodRoutes } from './routes/food-route.js';
import { dietProtocolTemplateRoutes } from './routes/diet-protocol-template-route.js';
import { dietProtocolRoutes } from './routes/diet-protocol-route.js';
import { dietMealRoutes } from './routes/diet-meal-route.js';
import { dietFoodItemRoutes } from './routes/diet-food-item-route.js';
import { studentDashboardRoutes } from './routes/student-dashboard-route.js';
import { subscriptionPlanRoutes } from './routes/subscription-plan-route.js';
import { studentSubscriptionRoutes } from './routes/student-subscription-route.js';
import { subscriptionPaymentRoutes } from './routes/subscription-payment-route.js';
import { trainerBriefingRoutes } from './routes/trainer-briefing-route.js';
import { trainerDashboardRoutes } from './routes/trainer-dashboard-route.js';
import { platformPlanRoutes } from './routes/platform-plan-route.js';
import { asaasWebhookRoutes } from './routes/asaas-webhook-route.js';
import { startBriefingCron } from '../src/jobs/briefing-cron.js';
import { authenticate } from './hooks/auth-hook.js';
import { languageOnRequestHook, applyLabelsPreSerializationHook } from './hooks/i18n-hook.js';
import { healthRoutes } from './routes/health-route.js';
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

  const llmProvider = process.env.LLM_PROVIDER || 'anthropic';
  if (llmProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — AI assistant feature will be unavailable');
  }
  if (llmProvider === 'gemini' && !process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set — AI assistant feature will be unavailable');
  }

  const fastify = Fastify({
    logger: options.logger ?? true,
    // Railway runs behind a reverse proxy. Trust it so Fastify correctly detects HTTPS,
    // client IPs, and sets secure cookies consistently.
    trustProxy: true,
  });

  // Make prisma available to route handlers and services that need transactions.
  fastify.decorate('prisma', prisma);

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
      if (allowedOrigins.includes(normalizedOrigin) || 
          allowedOrigins.some(allowed => normalizedOrigin === allowed || normalizedOrigin.startsWith(allowed))) {
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

  // Register session support
  const isDev = process.env.NODE_ENV === 'development';
  await fastify.register(fastifySession, {
    secret: process.env.SESSION_SECRET,
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
    await fastify.register(fastifyRateLimit, config.rateLimit.global);
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

  // Root liveness probe (public)
  fastify.get('/', async () => {
    return { message: "i'm alive" };
  });

  // Register protected routes with authentication and per-user rate limiting
  await fastify.register(async (fastify) => {
    // Add authentication hook to all routes in this context
    fastify.addHook('onRequest', authenticate);

    // Configure per-user rate limit for this context (disabled in test environment)
    if (process.env.NODE_ENV !== 'test') {
      await fastify.register(fastifyRateLimit, {
        ...config.rateLimit.globalPerUser,
        keyGenerator: (request) => `user:${request.user.id}`,
      });
    }

    // Register all protected routes
    await fastify.register(trainerRoutes);
    await fastify.register(nutritionistRoutes);
    await fastify.register(userRoutes);
    await fastify.register(trainerInviteRoutes);
    await fastify.register(addressRoutes);
    await fastify.register(trainingProtocolTemplateRoutes);
    await fastify.register(trainingProtocolRoutes);
    await fastify.register(trainingTemplateRoutes);
    await fastify.register(trainingRoutes);
    await fastify.register(exerciseTemplateRoutes);
    await fastify.register(exerciseRoutes);
    await fastify.register(workoutSessionRoutes);
    await fastify.register(anamnesisRoutes);
    await fastify.register(adminAnamnesisRoutes);
    await fastify.register(adminVideoRoutes);
    await fastify.register(videoRoutes);
    await fastify.register(importPrimeCoachingRoutes);
    await fastify.register(aiRoutes);
    await fastify.register(trainerBrandingRoutes);
    await fastify.register(gamificationRoutes);
    await fastify.register(challengeRoutes);
    await fastify.register(workoutsTodayRoutes);
    await fastify.register(nutritionistPatientRoutes);
    await fastify.register(foodRoutes);
    await fastify.register(dietProtocolTemplateRoutes);
    await fastify.register(dietProtocolRoutes);
    await fastify.register(dietMealRoutes);
    await fastify.register(dietFoodItemRoutes);
    await fastify.register(studentDashboardRoutes);
    await fastify.register(subscriptionPlanRoutes);
    await fastify.register(studentSubscriptionRoutes);
    await fastify.register(subscriptionPaymentRoutes);
    await fastify.register(trainerBriefingRoutes);
    await fastify.register(trainerDashboardRoutes);
    await fastify.register(platformPlanRoutes);
  });

  // Daily briefing cron — enabled only in production or when ENABLE_BRIEFING_CRON=true.
  // Intentionally disabled in test runs and local dev to avoid spurious background work.
  // TODO(scaling): if running multiple instances, gate this with a leader-election or
  // DB advisory lock so only one instance runs the cron.
  const cronEnabled =
    process.env.NODE_ENV === 'production' || process.env.ENABLE_BRIEFING_CRON === 'true';
  if (cronEnabled) {
    startBriefingCron(prisma, fastify.log);
    fastify.log.info('[cron:briefing] daily 22:00 UTC refresh scheduled');
  }

  return fastify;
}

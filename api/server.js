import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifySession from '@fastify/session';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { prisma } from '../src/db.js';
import { authRoutes } from './routes/auth-route.js';
import { trainerRoutes } from './routes/trainer-route.js';
import { userRoutes } from './routes/user-route.js';

export async function buildServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? true,
    // Railway runs behind a reverse proxy. Trust it so Fastify correctly detects HTTPS,
    // client IPs, and sets secure cookies consistently.
    trustProxy: true,
  });

  // Make prisma available to route handlers and services that need transactions.
  fastify.decorate('prisma', prisma);

  // Register CORS support
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Define allowed origins - normalize URLs by removing trailing slashes
  const normalizeUrl = (url) => url?.replace(/\/$/, '') || '';
  const allowedOrigins = isDevelopment 
    ? true // Allow all in development
    : [
        normalizeUrl(process.env.FRONTEND_URL),
        normalizeUrl(process.env.FRONTEND_REDIRECT_URL),
        'https://www.treinoway.com.br', // Fallback hardcoded for staging
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
        title: 'gaujofit_service',
        description: 'Backend for gaujofit',
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

  // Register Rate Limiting
  await fastify.register(fastifyRateLimit, {
    max: 100, // Global limit: 100 req/min
    timeWindow: '1 minute',
  });

  // Register auth routes
  await fastify.register(authRoutes);
  await fastify.register(trainerRoutes);
  await fastify.register(userRoutes);

  // Health check endpoint (public)
  fastify.get('/', async () => {
    return { message: "i'm alive" };
  });

  return fastify;
}

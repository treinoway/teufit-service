import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { prisma } from '../src/db.js';
import { authRoutes } from './routes/auth-route.js';
import { trainerRoutes } from './routes/trainer-route.js';
import { userRoutes } from './routes/user-route.js';

const fastify = Fastify({
  logger: true,
  // Railway runs behind a reverse proxy. Trust it so Fastify correctly detects HTTPS,
  // client IPs, and sets secure cookies consistently.
  trustProxy: true,
});

// Make prisma available to route handlers and services that need transactions.
fastify.decorate('prisma', prisma);

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
await fastify.register(fastifySession, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // use secure cookies in production
    httpOnly: true,
    sameSite: 'none',
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

// Start server
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    console.log(`🚀 Server is running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

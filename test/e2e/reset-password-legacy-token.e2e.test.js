import 'dotenv/config';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { hashPassword } from '../../src/helpers/password.js';
import config from '../../config/index.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { PasswordResetErrorCode, PasswordResetMessageCode } from '../../src/constants/password-reset.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const LEGACY_LOG_MESSAGE = 'password_reset.legacy_token_used';
const WARN_LEVEL = 40;
const PASSWORD = 'StrongPassw0rd!';
const NEW_PASSWORD = 'BrandNewPassw0rd!';
const VALID_CODE = '424242';
const WRONG_CODE = '000000';
const LEGACY_GLOBAL_MAX = 30;
const REQUESTS_PER_IP = 5;
// Hex sha256 digest, matching how reset codes are stored.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

e2eDescribe('e2e: reset-password legacy token (log + global rate limit)', () => {
  let app;
  let logLines;

  // why: rate limiters are disabled when NODE_ENV=test, so the app is built under development.
  async function buildRateLimitedApp() {
    logLines = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(...chunk.toString().split('\n').filter(Boolean));
        callback();
      },
    });
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      return await setupApp({ logger: { level: 'info', stream } });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }

  async function seedUserWithCode(code) {
    const email = `legacy-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(PASSWORD),
        roles: [],
        status: 'pending',
        accounts: { create: { provider: EMAIL_PROVIDER, providerId: email } },
      },
    });
    await prisma.passwordResetToken.create({
      data: { tokenHash: sha256(code), userId: user.id, expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
    });
    return { email, userId: user.id };
  }

  const resetFrom = (remoteAddress, payload) =>
    app.inject({ method: 'POST', url: '/auth/reset-password', remoteAddress, payload });
  const legacyFrom = (remoteAddress, token = WRONG_CODE) =>
    resetFrom(remoteAddress, { token, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD });
  const ipForRequest = (index) => `10.1.${Math.floor(index / REQUESTS_PER_IP)}.1`;
  const legacyLogLines = () => logLines.filter((line) => line.includes(LEGACY_LOG_MESSAGE));

  // why: the module only exists once the breaker is implemented; absent, there is nothing to reset.
  const resetCircuit = async () => {
    const circuit = await import('../../src/helpers/legacy-reset-circuit.js').catch(() => null);
    circuit?.resetLegacyResetCircuit();
  };

  beforeEach(async () => {
    await cleanDatabase();
    await resetCircuit();
    app = await buildRateLimitedApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    await resetCircuit();
  });

  describe('legacy usage log', () => {
    it('should emit a warn log with outcome success and without the code or email on a successful legacy reset', async () => {
      const { email } = await seedUserWithCode(VALID_CODE);

      const res = await legacyFrom('10.9.0.1', VALID_CODE);

      expect(res.statusCode).toBe(200);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'success' });
      expect(lines[0]).not.toContain(VALID_CODE);
      expect(lines[0]).not.toContain(email);
    });

    it('should emit a warn log with outcome invalid_code and without the code on a failed legacy reset', async () => {
      const res = await legacyFrom('10.9.0.2', WRONG_CODE);

      expect(res.statusCode).toBe(400);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'invalid_code' });
      expect(lines[0]).not.toContain(WRONG_CODE);
    });

    it('should not emit the legacy log for a new-path request', async () => {
      await resetFrom('10.9.0.3', {
        email: 'nobody@example.com',
        code: WRONG_CODE,
        password: NEW_PASSWORD,
        passwordConfirmation: NEW_PASSWORD,
      });

      expect(legacyLogLines()).toHaveLength(0);
    });
  });

  describe('legacy global rate limit', () => {
    const originalLegacyConfig = config.auth.legacyResetToken;

    afterEach(() => {
      config.auth.legacyResetToken = originalLegacyConfig;
    });

    it('should answer 429 request.rateLimitExceeded on the 31st legacy request even when sent from many IPs', async () => {
      for (let index = 0; index < LEGACY_GLOBAL_MAX; index += 1) {
        const res = await legacyFrom(ipForRequest(index));
        expect(res.statusCode, `request ${index + 1}`).toBe(400);
      }

      const res = await legacyFrom(ipForRequest(LEGACY_GLOBAL_MAX));

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: expect.any(String), messageCode: 'request.rateLimitExceeded' });
    });

    it('should not throttle a new-path request once the legacy bucket is exhausted', async () => {
      for (let index = 0; index <= LEGACY_GLOBAL_MAX; index += 1) {
        await legacyFrom(ipForRequest(index));
      }

      const res = await resetFrom('10.8.0.1', {
        email: 'nobody@example.com',
        code: WRONG_CODE,
        password: NEW_PASSWORD,
        passwordConfirmation: NEW_PASSWORD,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: PasswordResetErrorCode.INVALID_CODE,
        messageCode: PasswordResetMessageCode.INVALID_CODE,
      });
    });

    it('should not count new-path requests in the legacy bucket', async () => {
      for (let index = 0; index < LEGACY_GLOBAL_MAX; index += 1) {
        await resetFrom(ipForRequest(index), {
          email: 'nobody@example.com',
          code: WRONG_CODE,
          password: NEW_PASSWORD,
          passwordConfirmation: NEW_PASSWORD,
        });
      }

      const res = await legacyFrom('10.7.0.1');

      expect(res.statusCode).toBe(400);
    });
  });

  describe('legacy outcomes without a code lookup', () => {
    const originalLegacyConfig = config.auth.legacyResetToken;

    afterEach(() => {
      config.auth.legacyResetToken = originalLegacyConfig;
    });

    it('should log outcome disabled without the code when the kill switch is off', async () => {
      config.auth.legacyResetToken = { ...originalLegacyConfig, enabled: false };

      const res = await legacyFrom('10.6.0.1', VALID_CODE);

      expect(res.statusCode).toBe(400);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'disabled' });
      expect(lines[0]).not.toContain(VALID_CODE);
    });

    it('should log outcome disabled when the circuit breaker is open', async () => {
      config.auth.legacyResetToken = { ...originalLegacyConfig, circuitBreaker: { maxInvalid: 1, windowMs: 3600000 } };
      await legacyFrom('10.6.0.2', WRONG_CODE);
      logLines.length = 0;

      const res = await legacyFrom('10.6.0.3', VALID_CODE);

      expect(res.statusCode).toBe(400);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'disabled' });
    });

    it('should log the circuit-open warn event once when the breaker trips', async () => {
      config.auth.legacyResetToken = { ...originalLegacyConfig, circuitBreaker: { maxInvalid: 2, windowMs: 3600000 } };

      for (let index = 0; index < 4; index += 1) await legacyFrom(`10.6.1.${index}`, WRONG_CODE);

      const opened = logLines.filter((line) => line.includes('password_reset.legacy_circuit_open'));
      expect(opened).toHaveLength(1);
      expect(JSON.parse(opened[0])).toMatchObject({ level: WARN_LEVEL, event: 'password_reset.legacy_circuit_open' });
    });

    it('should log outcome validation_error without the code on a password mismatch', async () => {
      const res = await resetFrom('10.6.0.4', { token: VALID_CODE, password: NEW_PASSWORD, passwordConfirmation: 'Different1Passw0rd!' });

      expect(res.statusCode).toBe(400);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'validation_error' });
      expect(lines[0]).not.toContain(VALID_CODE);
    });

    it('should log outcome validation_error on a weak password', async () => {
      const res = await resetFrom('10.6.0.5', { token: VALID_CODE, password: 'abc123', passwordConfirmation: 'abc123' });

      expect(res.statusCode).toBe(400);
      const lines = legacyLogLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: WARN_LEVEL, outcome: 'validation_error' });
    });

    it('should not count legacy requests answered while the kill switch is off in the legacy bucket', async () => {
      config.auth.legacyResetToken = { ...originalLegacyConfig, enabled: false };
      for (let index = 0; index <= LEGACY_GLOBAL_MAX; index += 1) {
        const res = await legacyFrom(ipForRequest(index));
        expect(res.statusCode, `request ${index + 1}`).toBe(400);
      }
      config.auth.legacyResetToken = { ...originalLegacyConfig, enabled: true };

      const res = await legacyFrom('10.5.0.1');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: PasswordResetErrorCode.INVALID_CODE });
    });
  });

  describe('legacy hourly rate limit', () => {
    const originalLegacyConfig = config.auth.legacyResetToken;
    const HOURLY_MAX = 3;

    afterEach(() => {
      config.auth.legacyResetToken = originalLegacyConfig;
    });

    it('should answer 429 request.rateLimitExceeded once the hourly bucket is exhausted while the per-minute bucket still has room', async () => {
      config.auth.legacyResetToken = {
        ...originalLegacyConfig,
        rateLimit: { max: 1000, timeWindow: '1 minute' },
        rateLimitHourly: { max: HOURLY_MAX, timeWindow: '1 hour' },
        circuitBreaker: { maxInvalid: 1000, windowMs: 3600000 },
      };
      await app.close();
      app = await buildRateLimitedApp();
      for (let index = 0; index < HOURLY_MAX; index += 1) {
        const res = await legacyFrom(ipForRequest(index));
        expect(res.statusCode, `request ${index + 1}`).toBe(400);
      }

      const res = await legacyFrom(ipForRequest(HOURLY_MAX));

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ messageCode: 'request.rateLimitExceeded' });
    });
  });
});

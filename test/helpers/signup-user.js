import crypto from 'node:crypto';
import { prisma } from '../../src/db.js';

/** Code written over the emailed one so tests can verify without reading the inbox. */
export const TEST_SIGNUP_CODE = '424242';

const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Waits for the code that POST /auth/signup issues AFTER responding (deferred
 * work) and returns its row. Throws when none shows up, e.g. because the email
 * already has an account (that branch never issues a code).
 */
export async function waitForPendingSignupCode(email, { createdAfter = new Date(0) } = {}) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const code = await prisma.pendingSignupCode.findFirst({
      where: { pendingSignup: { email: normalizedEmail }, used: false, sendFailedAt: null, createdAt: { gte: createdAfter } },
      orderBy: { createdAt: 'desc' },
    });
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`No signup code was issued for ${normalizedEmail} (does the email already have an account?)`);
}

/** Replaces the active signup code's hash so TEST_SIGNUP_CODE verifies it. */
export async function forceSignupCode(email, code = TEST_SIGNUP_CODE) {
  const active = await waitForPendingSignupCode(email);
  await prisma.pendingSignupCode.update({ where: { id: active.id }, data: { tokenHash: sha256(code) } });
  return code;
}

/**
 * Drop-in replacement for the old one-step `app.inject({ url: '/auth/signup', ... })`
 * used by suites that only need an authenticated user: runs the real
 * signup → code → verify flow and returns the verify response (201 with
 * `{ user, token, refreshToken, linkedTrainers }`, same shape as the old signup).
 * `method` / `url` in the options are ignored; `payload` and `headers` are reused.
 */
export async function signupVerified(app, { payload, headers } = {}) {
  const signupResponse = await app.inject({ method: 'POST', url: '/auth/signup', payload, headers });
  if (signupResponse.statusCode !== 202) return signupResponse;

  const code = await forceSignupCode(payload.email);
  return app.inject({
    method: 'POST',
    url: '/auth/signup/verify',
    payload: { email: payload.email, code, password: payload.password },
    headers,
  });
}

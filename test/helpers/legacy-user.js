import { prisma } from '../../src/db.js';
import { hashPassword } from '../../src/helpers/password.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { sendVerificationCodeSafely } from '../../src/services/email-verification-service.js';

/**
 * Seeds an email/password user whose email is NOT verified, as the old
 * one-step POST /auth/signup used to create (that endpoint no longer creates
 * accounts). Like the old signup, a first verification code is issued and
 * emailed through `emailHandler` (so suite spies capture it), and tokens come
 * from a real POST /auth/login. Used by suites that exercise flows for such
 * pre-existing accounts: authenticated verify-email, pre-account-hijack
 * defences, invite redeem.
 *
 * @returns {Promise<{ userId: string, accessToken: string, refreshToken: string, email: string }>}
 */
export async function seedLegacyUnverifiedUser(app, { email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      roles: [],
      status: 'pending',
      accounts: { create: { provider: EMAIL_PROVIDER, providerId: normalizedEmail } },
    },
  });

  await sendVerificationCodeSafely(prisma, { userId: user.id, email: normalizedEmail });

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: normalizedEmail, password },
  });
  if (loginResponse.statusCode !== 200) {
    throw new Error(`Login of the seeded legacy user failed with ${loginResponse.statusCode}`);
  }
  const body = loginResponse.json();
  return {
    userId: user.id,
    accessToken: body.token.accessToken,
    refreshToken: body.refreshToken,
    email: normalizedEmail,
  };
}

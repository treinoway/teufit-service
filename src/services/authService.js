import { prisma } from '../db.js';
import { findOrCreateUserFromOAuth } from '../helpers/auth.js';
import { Roles } from '../constants/roles.js';

async function fetchGoogleUserProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Failed to fetch Google user profile (${res.status})`);
    err.code = 'GOOGLE_PROFILE_FETCH_FAILED';
    err.statusCode = 502;
    err.details = body;
    throw err;
  }

  return res.json();
}

/**
 * Complete Google OAuth callback flow:
 * - exchange code for token
 * - fetch Google user profile
 * - upsert User/Account
 * - return the persisted user
 */
export async function authenticateWithGoogle({ fastify, request }) {
  const { token } = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

  const googleUser = await fetchGoogleUserProfile(token.access_token);

  const user = await findOrCreateUserFromOAuth({
    provider: 'google',
    providerId: googleUser.id,
    email: googleUser.email,
    name: googleUser.name,
    avatar: googleUser.picture,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token,
    role: request.session.get('oauthRole'),
  });

  return { user, token, googleUser };
}

export async function getCurrentUserWithAccounts(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      accounts: {
        select: {
          provider: true,
          createdAt: true,
        },
      },
    },
  });
}

/**
 * Ensure a user has an associated profile row.
 * NOTE: This does not attempt to "decide" which one; it's driven by the caller.
 */
export async function ensureProfileForUser({ userId, role }) {
  if (role === Roles.STUDENT) {
    const existing = await prisma.student.findFirst({ where: { userId } });
    if (existing) return { created: false, role };

    // Minimal defaults; callers can update later.
    await prisma.student.create({
      data: {
        userId,
        name: 'New Student',
        birthdate: new Date('2000-01-01'),
      },
    });
    return { created: true, role };
  }

  if (role === Roles.TRAINER) {
    const existing = await prisma.trainer.findFirst({ where: { userId } });
    if (existing) return { created: false, role };

    await prisma.trainer.create({
      data: {
        userId,
        firstName: 'New',
        lastName: 'Trainer',
        birthDate: new Date('2000-01-01'),
      },
    });
    return { created: true, role };
  }

  const err = new Error('Invalid profile type');
  err.code = 'INVALID_PROFILE_TYPE';
  err.statusCode = 400;
  throw err;
}

import { prisma } from '../db.js';
import { findOrCreateUserFromOAuth } from '../helpers/auth.js';
import { Roles } from '../constants/roles.js';

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

/**
 * Ensure a user has an associated profile row.
 * NOTE: This does not attempt to "decide" which one; it's driven by the caller.
 */
// profileSeed is optional, used to populate profile defaults from OAuth info.
export async function ensureProfileForUser({ userId, role, profileSeed = {} }) {
  if (role === Roles.TRAINER) {
    const existing = await prisma.trainer.findFirst({ where: { userId } });
    if (existing) return { created: false, role };

    const rawName = typeof profileSeed?.name === 'string' ? profileSeed.name.trim() : '';
    const rawGiven = typeof profileSeed?.givenName === 'string' ? profileSeed.givenName.trim() : '';
    const rawFamily = typeof profileSeed?.familyName === 'string' ? profileSeed.familyName.trim() : '';

    // Try to split the full name ("Ada Lovelace" -> ["Ada", "Lovelace"]) if given/family aren't provided.
    const parts = rawName ? rawName.split(/\s+/).filter(Boolean) : [];
    const inferredFirst = rawGiven || parts[0] || 'New';
    const inferredLast = rawFamily || (parts.length > 1 ? parts.slice(1).join(' ') : '') || 'Trainer';

    await prisma.trainer.create({
      data: {
        userId,
        firstName: inferredFirst,
        lastName: inferredLast,
        // Keep a deterministic default for old tests/flows; it can be updated later by onboarding.
        birthDate: new Date('2000-01-01'),
        // Only set avatar if provided. (Passing undefined can break strict test expectations.)
        ...(profileSeed.avatar != null ? { avatar: profileSeed.avatar } : {}),
      },
    });
    return { created: true, role };
  }

  const err = new Error('Invalid profile type');
  err.code = 'INVALID_PROFILE_TYPE';
  err.statusCode = 400;
  throw err;
}

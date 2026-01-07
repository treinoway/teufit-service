/**
 * EXAMPLE: How to add GitHub OAuth (or any other provider)
 * 
 * This file shows how the new Account table pattern makes adding
 * new SSO providers super easy - no schema changes needed!
 */

// 1. Install the OAuth plugin (if not using @fastify/oauth2)
// npm install @fastify/oauth2

// 2. Add to your .env file:
// GITHUB_CLIENT_ID=your_github_client_id
// GITHUB_CLIENT_SECRET=your_github_client_secret
// GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

// 3. Add to your auth routes (api/routes/auth.js):

/*
import { findOrCreateUserFromOAuth } from '../../src/helpers/auth.js';

// Register GitHub OAuth2
fastify.register(import('@fastify/oauth2'), {
  name: 'githubOAuth2',
  credentials: {
    client: {
      id: process.env.GITHUB_CLIENT_ID,
      secret: process.env.GITHUB_CLIENT_SECRET,
    },
    auth: import('@fastify/oauth2').then(m => m.GITHUB_CONFIGURATION),
  },
  startRedirectPath: '/auth/github',
  callbackUri: process.env.GITHUB_CALLBACK_URL,
  scope: ['read:user', 'user:email'],
});

// GitHub callback route
fastify.get('/auth/github/callback', async (request, reply) => {
  try {
    const { token } = await fastify.githubOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

    // Get user info from GitHub
    const userInfoResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'User-Agent': 'Gaujofit-App',
      },
    });

    const githubUser = await userInfoResponse.json();

    // Get user's email (GitHub might require separate call)
    const emailResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'User-Agent': 'Gaujofit-App',
      },
    });
    const emails = await emailResponse.json();
    const primaryEmail = emails.find(e => e.primary)?.email;

    // Use the same helper function - no schema changes needed!
    const user = await findOrCreateUserFromOAuth({
      provider: 'github',              // Just change the provider name
      providerId: githubUser.id.toString(),
      email: primaryEmail,
      name: githubUser.name || githubUser.login,
      avatar: githubUser.avatar_url,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_at,
    });

    // Store user in session
    request.session.set('user', {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    });

    return reply.redirect('/dashboard');
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ error: 'GitHub authentication failed' });
  }
});
*/

// 4. That's it! No database schema changes needed!
// The Account table handles any provider automatically.

// 5. Same pattern works for:
// - Facebook OAuth
// - Apple Sign In  
// - Microsoft OAuth
// - Twitter OAuth
// - Any OAuth 2.0 provider!

export const example = 'See comments above for implementation';

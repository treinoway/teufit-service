// Middleware to check if user is authenticated
export async function authenticate(request, reply) {
  // 1) Prefer server-side session (web)
  const sessionUser = request.session?.get?.('user');
  if (sessionUser) {
    request.user = sessionUser;
    return;
  }

  // 2) Fallback to access token (JWT) from Authorization header (mobile)
  const authHeader = request.headers?.authorization;

  let token = null;
  if (typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (/^bearer\s+/i.test(trimmed)) {
      token = trimmed.replace(/^bearer\s+/i, '').trim();
    } else if (trimmed.split('.').length === 3) {
      // Support raw JWTs (some clients send just the token)
      token = trimmed;
    }
  }

  if (token) {
    if (typeof request.jwtVerify !== 'function') {
      return reply.status(500).send({
        error: 'JWT_NOT_CONFIGURED',
        message: 'JWT support not registered on server',
      });
    }

    try {
      // Explicitly verify the extracted token.
      const payload = await request.jwtVerify({ token });
      request.user = {
        id: payload.sub,
        email: payload.email ?? null,
        role: payload.role,
        status: payload.status,
      };
      return;
    } catch (e) {
      return reply.status(401).send({
        error: 'Authentication required',
        message: 'Invalid or expired token',
      });
    }
  }

  return reply.status(401).send({
    error: 'Authentication required',
    message: 'Missing Authorization header',
  });
}

// Middleware to check if user has specific role
export function requireRole(role) {
  return async function (request, reply) {
    const user = request.user || request.session?.get?.('user');
    if (!user) return reply.status(401).send({ error: 'Authentication required' });

    if (user.role !== role) {
      return reply.status(403).send({ 
        error: 'Forbidden',
        message: `This resource requires ${role} role`
      });
    }
    
    request.user = user;
  };
}

// Middleware to check if the authenticated user is active (e.g. finished onboarding)
export function requireActiveUser() {
  return async function (request, reply) {
    const user = request.user || request.session?.get?.('user');
    if (!user) return reply.status(401).send({ error: 'Authentication required' });

    if (user.status !== 'active') {
      return reply.status(403).send({
        error: 'Account not active',
        message: 'Please complete onboarding before accessing this resource',
        status: user.status,
      });
    }

    request.user = user;
  };
}

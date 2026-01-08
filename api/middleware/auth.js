// Middleware to check if user is authenticated
export async function authenticate(request, reply) {
  // 1) Prefer server-side session (web)
  const sessionUser = request.session?.get?.('user');
  if (sessionUser) {
    request.user = sessionUser;
    return;
  }

  // 2) Fallback to Bearer token (mobile)
  const authHeader = request.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice('bearer '.length).trim();
    try {
      // fastify-jwt attaches jwtVerify to request when registered.
      const payload = await request.jwtVerify();
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
    message: 'Please login with Google to access this resource',
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

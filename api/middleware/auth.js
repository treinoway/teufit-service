import config from '../../config/index.js';
import { hasBetaAccess } from '../../src/helpers/beta-access.js';
import { ForbiddenAppError, UnauthorizedAppError } from '../../src/errors/app-error.js';
import { InviteMessageCode } from '../../src/constants/trainer-invite.js';

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
        roles: payload.roles || (payload.role ? [payload.role] : []),
        status: payload.status,
      };
      return;
    } catch (err) {
      request.log.warn({ error: err }, 'JWT verification failed in authenticate middleware');
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

// Middleware to check if user has specific role(s)
// Accepts either a single role string or an array of allowed roles
export function requireRole(allowedRoles) {
  return async function (request, reply) {
    const user = request.user || request.session?.get?.('user');
    if (!user) return reply.status(401).send({ error: 'Authentication required' });

    // Normalize allowedRoles to array
    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
    // Normalize user.roles to array (support both old single role and new roles array)
    const userRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    
    // Check if user has at least one of the allowed roles
    const hasRole = userRoles.some(role => rolesArray.includes(role));
    
    if (!hasRole) {
      return reply.status(403).send({ 
        error: 'Forbidden',
        message: `This resource requires one of the following roles: ${rolesArray.join(', ')}`
      });
    }
    
    request.user = user;
  };
}

// Middleware to close the /become-trainer self-promotion bypass during the
// closed beta. Exempts admins, existing trainers, and the bootstrap admin
// (via hasBetaAccess) — only a plain roles:[] user without an accepted
// TrainerInvite is blocked. Gated behind BETA_INVITE_GATE_ENABLED so the
// gate can be killed in an emergency without a deploy.
export function requireBetaAccess() {
  return async function (request) {
    if (config.betaInviteGate?.enabled === false) return;

    const user = request.user || request.session?.get?.('user');
    if (!user) {
      throw new UnauthorizedAppError({ message: 'Authentication required' });
    }

    const allowed = await hasBetaAccess(user);
    if (!allowed) {
      throw new ForbiddenAppError({
        error: 'INVITE_REQUIRED',
        messageCode: InviteMessageCode.REQUIRED,
        message: 'A trainer invite is required to access this feature during the closed beta.',
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

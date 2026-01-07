// Middleware to check if user is authenticated
export async function authenticate(request, reply) {
  const user = request.session.get('user');
  
  if (!user) {
    return reply.status(401).send({ 
      error: 'Authentication required',
      message: 'Please login with Google to access this resource'
    });
  }
  
  // Attach user to request for use in route handlers
  request.user = user;
}

// Middleware to check if user has specific role
export function requireRole(role) {
  return async function (request, reply) {
    const user = request.session.get('user');
    
    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    
    if (user.role !== role) {
      return reply.status(403).send({ 
        error: 'Forbidden',
        message: `This resource requires ${role} role`
      });
    }
    
    request.user = user;
  };
}

export async function authenticate(request, reply) {
  try {
    // Check for JWT token first (for mobile/API clients)
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      await request.jwtVerify();
      return;
    }

    // Fall back to session (for web clients)
    if (request.session?.userId) {
      request.user = { id: request.session.userId };
      return;
    }

    // No valid authentication found
    reply.code(401).send({ error: 'Authentication required' });
  } catch (error) {
    reply.code(401).send({ error, message: 'Authentication failed' });
  }
}

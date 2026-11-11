import { buildServer } from './server.js';
import { registerShutdownHandlers } from './shutdown.js';

const fastify = await buildServer();
registerShutdownHandlers(fastify);

// Start server
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    console.log(`🚀 Server is running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

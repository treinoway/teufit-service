const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];
export const SHUTDOWN_TIMEOUT_MS = 8000;

// Starts an early, fire-and-forget tracer flush so completed turns survive a slow drain.
function flushTracerEarly(fastify) {
  try {
    Promise.resolve(fastify.aiTracer?.forceFlush?.()).catch(() => {});
  } catch {
    // why: tracing must never block or fail the shutdown path.
  }
}

// Closes the server on SIGTERM/SIGINT (running onClose hooks such as the tracer flush), then exits.
export function registerShutdownHandlers(fastify, { proc = process, timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  let closing = false;
  const handle = async () => {
    if (closing) return;
    closing = true;
    // why: the timer is a last resort above the tracer's own 5 s bound, so a hung hook cannot block the deploy.
    const hardExit = setTimeout(() => proc.exit(1), timeoutMs);
    hardExit.unref?.();
    flushTracerEarly(fastify);
    try {
      await fastify.close();
      clearTimeout(hardExit);
      proc.exit(0);
    } catch (err) {
      fastify.log?.error?.(err);
      clearTimeout(hardExit);
      proc.exit(1);
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.once(signal, handle);
}

/**
 * Runs `task` once the response has been sent (`close` fires after the body is
 * flushed, or when the client goes away). Used by the public signup endpoints
 * so their latency never depends on which branch ran (DB writes, email
 * provider), which would otherwise reveal whether an email has an account.
 * Failures are logged, never surfaced.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {() => Promise<unknown>} task
 * @param {{ error: Function }} logger
 * @param {string} taskName - Logged on failure (never log request data here).
 */
export function runAfterResponse(reply, task, logger, taskName) {
  reply.raw.once('close', () => {
    Promise.resolve()
      .then(task)
      .catch((error) => logger.error({ err: error, task: taskName }, 'Deferred task failed'));
  });
}

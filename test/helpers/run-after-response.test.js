import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { runAfterResponse } from '../../src/helpers/run-after-response.js';

const TASK_NAME = 'signup';

function makeReply() {
  return { raw: new EventEmitter() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('runAfterResponse', () => {
  it('should not run the task before the response is closed', async () => {
    const reply = makeReply();
    const task = vi.fn().mockResolvedValue(undefined);

    runAfterResponse(reply, task, { error: vi.fn() }, TASK_NAME);
    await flush();

    expect(task).not.toHaveBeenCalled();
  });

  it('should run the task exactly once after the response closes', async () => {
    const reply = makeReply();
    const task = vi.fn().mockResolvedValue(undefined);

    runAfterResponse(reply, task, { error: vi.fn() }, TASK_NAME);
    reply.raw.emit('close');
    reply.raw.emit('close');
    await flush();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('should log a failing task with its name instead of throwing', async () => {
    const reply = makeReply();
    const failure = new Error('db down');
    const logger = { error: vi.fn() };

    runAfterResponse(reply, vi.fn().mockRejectedValue(failure), logger, TASK_NAME);
    reply.raw.emit('close');
    await flush();

    expect(logger.error).toHaveBeenCalledWith({ err: failure, task: TASK_NAME }, 'Deferred task failed');
  });

  it('should also catch a task that throws synchronously', async () => {
    const reply = makeReply();
    const logger = { error: vi.fn() };

    runAfterResponse(reply, () => { throw new Error('boom'); }, logger, TASK_NAME);
    reply.raw.emit('close');
    await flush();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

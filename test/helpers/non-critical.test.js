import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runNonCritical } from '../../src/helpers/non-critical.js';

const LABEL = 'Some milestone';

describe('runNonCritical', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should run the task once and not log when it succeeds', async () => {
    const task = vi.fn().mockResolvedValue(undefined);

    await runNonCritical(LABEL, task);

    expect(task).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('should await an async task before resolving', async () => {
    let finished = false;
    const task = async () => {
      await Promise.resolve();
      finished = true;
    };

    await runNonCritical(LABEL, task);

    expect(finished).toBe(true);
  });

  it('should swallow a rejected task and log it with the label', async () => {
    const task = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(runNonCritical(LABEL, task)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(`${LABEL} failed (non-critical): db down`);
  });

  it('should swallow a synchronously throwing task and log it with the label', async () => {
    const task = () => {
      throw new Error('boom');
    };

    await expect(runNonCritical(LABEL, task)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(`${LABEL} failed (non-critical): boom`);
  });
});

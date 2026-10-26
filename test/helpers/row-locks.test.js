import { describe, it, expect, vi } from 'vitest';
import { lockTrainingTemplateForUpdate } from '../../src/helpers/row-locks.js';

describe('lockTrainingTemplateForUpdate', () => {
  it('locks the training_templates row FOR UPDATE with the given id', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await lockTrainingTemplateForUpdate(tx, 'tt-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, id] = tx.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('FROM training_templates');
    expect(sql).toContain('FOR UPDATE');
    expect(id).toBe('tt-1');
  });
});

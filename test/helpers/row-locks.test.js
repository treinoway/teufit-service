import { describe, it, expect, vi } from 'vitest';
import { lockTrainingTemplateForUpdate, lockDietProtocolForUpdate } from '../../src/helpers/row-locks.js';

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

describe('lockDietProtocolForUpdate', () => {
  const planId = 'plan-1';

  it('issues exactly one $queryRaw on the given tx', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await lockDietProtocolForUpdate(tx, planId);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('targets the diet_protocols table with FOR NO KEY UPDATE', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await lockDietProtocolForUpdate(tx, planId);

    const [strings] = tx.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('FROM diet_protocols');
    expect(sql).toContain('FOR NO KEY UPDATE');
  });

  it('binds the id as a parameter instead of interpolating it into the SQL', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await lockDietProtocolForUpdate(tx, planId);

    const [strings, id] = tx.$queryRaw.mock.calls[0];
    expect(id).toBe(planId);
    expect(strings.join('?')).not.toContain(planId);
  });

  it('propagates errors raised by the query', async () => {
    const failure = new Error('lock timeout');
    const tx = { $queryRaw: vi.fn().mockRejectedValue(failure) };

    await expect(lockDietProtocolForUpdate(tx, planId)).rejects.toBe(failure);
  });
});

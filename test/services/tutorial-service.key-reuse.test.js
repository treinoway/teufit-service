import { describe, it, expect, vi } from 'vitest';
import { assertVideoKeyUnused } from '../../src/services/tutorial-service.js';

const KEY = 'tutorials/11111111-1111-4111-8111-111111111111.mp4';
const TUTORIAL_ID = '22222222-2222-4222-8222-222222222222';

// Builds a Prisma-like mock exposing tutorial.findFirst.
function makeDb(found) {
  return { tutorial: { findFirst: vi.fn().mockResolvedValue(found) } };
}

describe('assertVideoKeyUnused', () => {
  it('rejects a key already stored on another tutorial', async () => {
    const db = makeDb({ id: 'other' });
    await expect(assertVideoKeyUnused(db, { videoSource: 'upload', videoKey: KEY }))
      .rejects.toMatchObject({ httpStatus: 400, messageCode: 'tutorial.invalidVideoKey' });
    expect(db.tutorial.findFirst).toHaveBeenCalledWith({ where: { videoKey: KEY }, select: { id: true } });
  });

  it('excludes the tutorial being updated from the lookup', async () => {
    const db = makeDb(null);
    await expect(assertVideoKeyUnused(db, { videoSource: 'upload', videoKey: KEY }, TUTORIAL_ID))
      .resolves.toBeUndefined();
    expect(db.tutorial.findFirst).toHaveBeenCalledWith({
      where: { videoKey: KEY, NOT: { id: TUTORIAL_ID } },
      select: { id: true },
    });
  });

  it('skips the lookup for link sources and missing keys', async () => {
    const db = makeDb({ id: 'other' });
    await assertVideoKeyUnused(db, { videoSource: 'link', videoUrl: 'https://a.com' });
    await assertVideoKeyUnused(db, {});
    expect(db.tutorial.findFirst).not.toHaveBeenCalled();
  });
});

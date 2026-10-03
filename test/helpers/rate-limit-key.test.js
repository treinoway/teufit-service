import { describe, it, expect } from 'vitest';

import { userRateLimitKey } from '../../src/helpers/rate-limit-key.js';

describe('userRateLimitKey', () => {
  it('keys by authenticated user id, ignoring the IP', () => {
    const keyOf = userRateLimitKey('verify-email');

    expect(keyOf({ user: { id: 'user-1' }, ip: '1.1.1.1' })).toBe('verify-email:user-1');
    expect(keyOf({ user: { id: 'user-1' }, ip: '2.2.2.2' })).toBe('verify-email:user-1');
  });

  it('falls back to the IP when there is no authenticated user', () => {
    const keyOf = userRateLimitKey('verify-email');

    expect(keyOf({ ip: '1.1.1.1' })).toBe('verify-email:1.1.1.1');
    expect(keyOf({ user: {}, ip: '1.1.1.1' })).toBe('verify-email:1.1.1.1');
  });

  it('separates counters by namespace', () => {
    const request = { user: { id: 'user-1' }, ip: '1.1.1.1' };

    expect(userRateLimitKey('verify-email')(request)).not.toBe(userRateLimitKey('verify-email-resend')(request));
  });
});

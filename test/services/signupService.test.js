import { describe, it, expect } from 'vitest';

import { Roles } from '../../src/constants/roles.js';
import { startTrainerGoogleSignup } from '../../src/services/signupService.js';

function makeSession(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
  };
}

describe('src/services/signupService.js', () => {
  it('sets oauthRole and oauthFlow for trainer signup and returns redirectTo', () => {
    const request = { session: makeSession() };

    const res = startTrainerGoogleSignup({ request });

    expect(request.session.get('oauthRole')).toBe(Roles.TRAINER);
    expect(request.session.get('oauthFlow')).toBe('trainer-signup');
    expect(res).toEqual({ redirectTo: '/auth/google' });
  });
});

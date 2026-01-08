import { Roles } from '../constants/roles.js';

/**
 * Prepare the session for a trainer Google signup.
 *
 * Contract:
 * - Mutates request.session
 * - Returns a descriptor so routes can stay thin
 */
export function startTrainerGoogleSignup({ request }) {
  request.session.set('oauthRole', Roles.TRAINER);

  return {
    redirectTo: '/auth/google',
  };
}

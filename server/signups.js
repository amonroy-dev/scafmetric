// Scafmetric is a work in progress: people who already have an account (and
// allowlisted owners) can sign in, but no new accounts are created. Set
// SIGNUPS_OPEN=true in the environment and redeploy to let new users in again.
export const SIGNUPS_PAUSED_MESSAGE = 'Scafmetric is a work in progress, so new accounts are paused for now. Please check back soon.';

export function signupsOpen(env = process.env) {
  return env.SIGNUPS_OPEN === 'true';
}

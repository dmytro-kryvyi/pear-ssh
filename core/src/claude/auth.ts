/**
 * Whether an error line from the claude CLI means "not signed in". Pear owns
 * no credentials, so the only remedy it can offer is the CLI's own login
 * flow — the UI turns these into a Sign-in card instead of a raw error.
 */
const AUTH_ERROR = /not logged in|please run \/login|run `?\/login`?|oauth token (is )?(expired|revoked|invalid)|authentication[_ ](error|failed)|invalid api key|invalid authentication|\b401\b|unauthori[sz]ed/i;

export function isClaudeAuthError(text: string): boolean {
  return AUTH_ERROR.test(text);
}

import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from '../config';
import type { Guard } from '../security';
import type { SessionStore } from './sessions';

export const COOKIE = 'pear_session';
/** `__Host-`: browser-enforced Secure + Path=/ + no Domain — over https only. */
export const SECURE_COOKIE = '__Host-pear_session';

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionToken(req: IncomingMessage): string | undefined {
  return readCookie(req, SECURE_COOKIE) ?? readCookie(req, COOKIE);
}

export function sessionCookie(token: string | null, secure: boolean): string {
  const name = secure ? SECURE_COOKIE : COOKIE;
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])];
  if (token === null) return `${name}=; Max-Age=0; ${attrs.join('; ')}`;
  return `${name}=${token}; Max-Age=${30 * 24 * 60 * 60}; ${attrs.join('; ')}`;
}

export interface Identity {
  /** Present under proxy auth; password/none have one implicit user. */
  user?: string;
}

/** Who is this request from — or null if it may not come in. */
export function authenticate(
  req: IncomingMessage,
  config: ServerConfig,
  guard: Guard,
  sessions: SessionStore,
): Identity | null {
  switch (config.auth) {
    case 'none':
      return {};
    case 'password':
      return sessions.check(sessionToken(req)) ? {} : null;
    case 'proxy': {
      // The header is only worth anything if the proxy put it there. From any
      // other peer it is just a string the caller typed.
      if (!guard.isTrustedProxy(req)) return null;
      const raw = req.headers[config.proxyUserHeader];
      const user = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (!user) return null;
      if (config.allowUsers.length && !config.allowUsers.includes(user)) return null;
      return { user };
    }
  }
}

import type { BetterAuthOptions } from 'better-auth';
import { getCookies } from 'better-auth/cookies';

/**
 * Expire the Roomies Better Auth session cookie after a successful caller
 * commit. Uses Better Auth's own cookie name/attributes. Does not read or
 * write the database and does not invoke Better Auth account-removal APIs.
 */
export function expiredAuthSessionSetCookie(auth: {
  options: BetterAuthOptions;
}): string {
  const sessionToken = getCookies(auth.options).sessionToken;
  return serializeExpiredSessionCookie(
    sessionToken.name,
    sessionToken.attributes,
  );
}

function serializeExpiredSessionCookie(
  name: string,
  attributes: {
    domain?: string;
    httpOnly: boolean;
    path: string;
    secure: boolean;
    sameSite: string;
  },
): string {
  let cookie = `${name}=`;
  cookie += '; Max-Age=0';
  if (attributes.domain !== undefined && attributes.domain.length > 0) {
    cookie += `; Domain=${attributes.domain}`;
  }
  if (attributes.path) {
    cookie += `; Path=${attributes.path}`;
  }
  if (attributes.httpOnly) {
    cookie += '; HttpOnly';
  }
  if (attributes.secure) {
    cookie += '; Secure';
  }
  if (attributes.sameSite) {
    const sameSite = attributes.sameSite;
    cookie += `; SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`;
  }
  return cookie;
}

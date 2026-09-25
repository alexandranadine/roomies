export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const EMPTY_CURSOR_PAGE = {
  items: [],
  hasMore: false,
  nextCursor: null,
} as const;

export const DEFAULT_STRIP_MEMBERSHIPS = {
  currentMembershipId: 'm1111111-1111-4111-8111-111111111111',
  memberships: [
    {
      membershipId: 'm1111111-1111-4111-8111-111111111111',
      name: 'Alex',
    },
    {
      membershipId: 'm2222222-2222-4222-8222-222222222222',
      name: 'Jamie',
    },
  ],
} as const;

function pathnameOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

/**
 * Shared reads the Home shell now always performs. Stubs should consult this
 * before returning 404 so overview queries do not fail unrelated tests.
 */
export function responseForCommonHomeRead(
  url: string,
  method: string,
): Response | null {
  const path = pathnameOf(url);
  if (path === '/api/v1/notifications' && method === 'GET') {
    return jsonResponse(200, EMPTY_CURSOR_PAGE);
  }
  if (/^\/api\/v1\/homes\/[^/]+\/activity$/i.test(path) && method === 'GET') {
    return jsonResponse(200, EMPTY_CURSOR_PAGE);
  }
  if (
    /^\/api\/v1\/homes\/[^/]+\/memberships$/i.test(path) &&
    method === 'GET'
  ) {
    return jsonResponse(200, DEFAULT_STRIP_MEMBERSHIPS);
  }
  return null;
}

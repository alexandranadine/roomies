import { vi } from 'vitest';
import type { ActiveHome } from '../homes/homes-api.js';
import type { ActiveHomeMemberships } from '../homes/home-memberships-api.js';
import type { CreatedInvitation } from '../invitations/create-invitation-api.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { responseForCommonHomeRead } from '../test/common-home-reads.js';

export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CURRENT_MEMBERSHIP_ID = 'm1111111-1111-4111-8111-111111111111';
export const OTHER_MEMBERSHIP_ID = 'm2222222-2222-4222-8222-222222222222';
export const ENDED_MEMBERSHIP_ID = 'm3333333-3333-4333-8333-333333333333';
export const REJOIN_MEMBERSHIP_ID = 'm4444444-4444-4444-8444-444444444444';
export const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

export function errorBody(code: string, message: string) {
  return { error: { code, message, requestId: 'req_test' } };
}

export function defaultMemberships(): ActiveHomeMemberships {
  return {
    currentMembershipId: CURRENT_MEMBERSHIP_ID,
    memberships: [
      { membershipId: CURRENT_MEMBERSHIP_ID, name: 'Alex' },
      { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
    ],
  };
}

export function defaultCreatedInvitation(): CreatedInvitation {
  return {
    invitation: {
      id: INVITATION_ID,
      email: 'jamie@example.com',
      expiresAt: '2026-10-01T12:00:00.000Z',
    },
    inviteUrl: `http://localhost:5173/invitations/${INVITATION_ID}#secret=test-secret`,
  };
}

export type RoommatesStubState = {
  role: ActiveHome['role'];
  memberships: ActiveHomeMemberships;
  homes: ActiveHome[];
};

export type RoommatesStubHandlers = {
  createInvitation?: (body: unknown) => Response | Promise<Response>;
  changeRole?: (
    membershipId: string,
    body: unknown,
  ) => Response | Promise<Response>;
  remove?: (membershipId: string) => Response | Promise<Response>;
  leave?: (membershipId: string) => Response | Promise<Response>;
};

export type RoommatesStubOptions = {
  role?: ActiveHome['role'];
  memberships?: ActiveHomeMemberships;
  homes?: ActiveHome[];
  homeName?: string;
  handlers?: RoommatesStubHandlers;
};

export function stubRoommatesApis(options: RoommatesStubOptions = {}) {
  const state: RoommatesStubState = {
    role: options.role ?? 'ADMIN',
    memberships: options.memberships ?? defaultMemberships(),
    homes: options.homes ?? [
      {
        id: TEST_HOME_A,
        name: options.homeName ?? 'Oak Street',
        timezone: 'UTC',
        role: options.role ?? 'ADMIN',
        hasPhoto: false,
      },
    ],
  };

  const fetchMock = vi
    .fn()
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const homeName = options.homeName ?? 'Oak Street';

      if (path.endsWith('/api/v1/me') && method === 'GET') {
        return Promise.resolve(jsonResponse(200, { id: TEST_USER_ID }));
      }

      if (path.endsWith('/api/v1/me/homes') && method === 'GET') {
        const homes = state.homes.map((home) =>
          home.id === TEST_HOME_A ? { ...home, role: state.role } : home,
        );
        return Promise.resolve(jsonResponse(200, homes));
      }

      const inviteMatch = /^\/api\/v1\/homes\/([^/]+)\/invitations$/i.exec(
        path,
      );
      if (inviteMatch?.[1] !== undefined && method === 'POST') {
        const handler = options.handlers?.createInvitation;
        if (handler !== undefined) {
          return Promise.resolve(handler(init?.body));
        }
        return Promise.resolve(jsonResponse(201, defaultCreatedInvitation()));
      }

      const roleMatch =
        /^\/api\/v1\/homes\/([^/]+)\/memberships\/([^/]+)\/role$/i.exec(path);
      if (roleMatch?.[2] !== undefined && method === 'PATCH') {
        const handler = options.handlers?.changeRole;
        if (handler !== undefined) {
          return Promise.resolve(handler(roleMatch[2], init?.body));
        }
        return Promise.resolve(emptyResponse(204));
      }

      const removeMatch =
        /^\/api\/v1\/homes\/([^/]+)\/memberships\/([^/]+)\/remove$/i.exec(path);
      if (removeMatch?.[2] !== undefined && method === 'POST') {
        const handler = options.handlers?.remove;
        if (handler !== undefined) {
          return Promise.resolve(handler(removeMatch[2]));
        }
        state.memberships = {
          ...state.memberships,
          memberships: state.memberships.memberships.filter(
            (row) => row.membershipId !== removeMatch[2],
          ),
        };
        return Promise.resolve(emptyResponse(204));
      }

      const leaveMatch =
        /^\/api\/v1\/homes\/([^/]+)\/memberships\/([^/]+)\/leave$/i.exec(path);
      if (leaveMatch?.[2] !== undefined && method === 'POST') {
        const handler = options.handlers?.leave;
        if (handler !== undefined) {
          return Promise.resolve(handler(leaveMatch[2]));
        }
        state.homes = [];
        return Promise.resolve(emptyResponse(204));
      }

      const membershipsMatch = /^\/api\/v1\/homes\/([^/]+)\/memberships$/i.exec(
        path,
      );
      if (membershipsMatch?.[1] !== undefined && method === 'GET') {
        return Promise.resolve(jsonResponse(200, state.memberships));
      }

      const pulseMatch = /^\/api\/v1\/homes\/([^/]+)\/pulse$/i.exec(path);
      if (pulseMatch?.[1] !== undefined && method === 'GET') {
        return Promise.resolve(jsonResponse(200, clearHousePulse()));
      }

      const homeMatch = /^\/api\/v1\/homes\/([^/]+)$/i.exec(path);
      if (homeMatch?.[1] !== undefined && method === 'GET') {
        return Promise.resolve(
          jsonResponse(200, {
            id: homeMatch[1],
            name: homeMatch[1] === TEST_HOME_B ? 'Cedar House' : homeName,
            timezone: 'UTC',
            hasPhoto: false,
          }),
        );
      }

      const common = responseForCommonHomeRead(path, method);
      if (common !== null) {
        return Promise.resolve(common);
      }

      return Promise.resolve(
        jsonResponse(404, errorBody('NOT_FOUND', 'Not found')),
      );
    });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

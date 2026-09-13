import { vi } from 'vitest';
import type { ActiveHomeMemberships } from '../homes/home-memberships-api.js';
import type {
  MaintenanceDetail,
  MaintenanceListPage,
} from './maintenance-api.js';
import {
  jsonResponse,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_A,
  TEST_MEMBERSHIP_B,
  TEST_USER_ID,
} from './test-fixtures.js';

type HomeContextBody = {
  id: string;
  name: string;
  timezone: string;
};

export type MaintenanceStubOptions = {
  homes?: readonly {
    id: string;
    name: string;
    timezone: string;
    role: 'ADMIN' | 'ROOMMATE';
  }[];
  contexts?: Record<string, { status: number; body: unknown }>;
  listByHome?: Record<
    string,
    | MaintenanceListPage
    | ((url: URL) => MaintenanceListPage | { status: number; body: unknown })
  >;
  detailByKey?: Record<
    string,
    MaintenanceDetail | { status: number; body: unknown }
  >;
  membershipsByHome?: Record<
    string,
    | ActiveHomeMemberships
    | { status: number; body: unknown }
    | (() => ActiveHomeMemberships | { status: number; body: unknown })
  >;
  createByHome?: Record<
    string,
    | MaintenanceDetail
    | { status: number; body: unknown }
    | ((body: unknown) => MaintenanceDetail | { status: number; body: unknown })
  >;
  resolveByKey?: Record<
    string,
    | MaintenanceDetail
    | { status: number; body: unknown }
    | ((body: unknown) => MaintenanceDetail | { status: number; body: unknown })
  >;
  listDelayMs?: number;
  detailDelayMs?: number;
  createDelayMs?: number;
  resolveDelayMs?: number;
};

function defaultContext(homeId: string): HomeContextBody {
  if (homeId === TEST_HOME_B) {
    return { id: TEST_HOME_B, name: 'Cedar House', timezone: 'UTC' };
  }
  return { id: TEST_HOME_A, name: 'Oak Street', timezone: 'UTC' };
}

export function defaultMemberships(
  homeId: string = TEST_HOME_A,
): ActiveHomeMemberships {
  if (homeId === TEST_HOME_B) {
    return {
      currentMembershipId: TEST_MEMBERSHIP_B,
      memberships: [
        { membershipId: TEST_MEMBERSHIP_B, name: 'Casey' },
        { membershipId: 'm3333333-3333-4333-8333-333333333333', name: 'Drew' },
      ],
    };
  }
  return {
    currentMembershipId: TEST_MEMBERSHIP_A,
    memberships: [
      { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
      { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
    ],
  };
}

export function detailCacheKey(homeId: string, entryId: string): string {
  return `${homeId}:${entryId}`;
}

function parseRequestBody(init?: RequestInit): unknown {
  if (init?.body === undefined || init.body === null) {
    return undefined;
  }
  if (typeof init.body === 'string') {
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function stubMaintenanceApis(options: MaintenanceStubOptions = {}) {
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

      if (path.endsWith('/api/v1/me/homes')) {
        return Promise.resolve(
          jsonResponse(
            200,
            options.homes ?? [
              {
                id: TEST_HOME_A,
                name: 'Oak Street',
                timezone: 'UTC',
                role: 'ADMIN',
              },
              {
                id: TEST_HOME_B,
                name: 'Cedar House',
                timezone: 'UTC',
                role: 'ROOMMATE',
              },
            ],
          ),
        );
      }

      if (path.endsWith('/api/v1/me')) {
        return Promise.resolve(jsonResponse(200, { id: TEST_USER_ID }));
      }

      const resolveMatch =
        /^\/api\/v1\/homes\/([^/]+)\/maintenance\/([^/]+)\/resolve$/i.exec(
          path,
        );
      if (
        resolveMatch?.[1] !== undefined &&
        resolveMatch[2] !== undefined &&
        method === 'POST'
      ) {
        const homeId = resolveMatch[1];
        const entryId = resolveMatch[2];
        const key = detailCacheKey(homeId, entryId);
        const configured = options.resolveByKey?.[key];
        const requestBody = parseRequestBody(init);
        const respond = () => {
          if (configured === undefined) {
            return jsonResponse(404, notFoundBody());
          }
          if (typeof configured === 'function') {
            const result = configured(requestBody);
            if ('status' in result && 'body' in result) {
              return jsonResponse(result.status, result.body);
            }
            return jsonResponse(200, result);
          }
          if ('status' in configured && 'body' in configured) {
            return jsonResponse(configured.status, configured.body);
          }
          return jsonResponse(200, configured);
        };
        if (options.resolveDelayMs !== undefined) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(respond());
            }, options.resolveDelayMs);
          });
        }
        return Promise.resolve(respond());
      }

      const detailMatch =
        /^\/api\/v1\/homes\/([^/]+)\/maintenance\/([^/]+)$/i.exec(path);
      if (
        detailMatch?.[1] !== undefined &&
        detailMatch[2] !== undefined &&
        method === 'GET'
      ) {
        const homeId = detailMatch[1];
        const entryId = detailMatch[2];
        const configured =
          options.detailByKey?.[detailCacheKey(homeId, entryId)];
        const respond = () => {
          if (configured === undefined) {
            return jsonResponse(404, notFoundBody());
          }
          if ('status' in configured && 'body' in configured) {
            return jsonResponse(configured.status, configured.body);
          }
          return jsonResponse(200, configured);
        };
        if (options.detailDelayMs !== undefined) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(respond());
            }, options.detailDelayMs);
          });
        }
        return Promise.resolve(respond());
      }

      const listMatch = /^\/api\/v1\/homes\/([^/]+)\/maintenance$/i.exec(path);
      if (listMatch?.[1] !== undefined) {
        const homeId = listMatch[1];
        if (method === 'POST') {
          const configured = options.createByHome?.[homeId];
          const requestBody = parseRequestBody(init);
          const respond = () => {
            if (configured === undefined) {
              return jsonResponse(404, notFoundBody());
            }
            if (typeof configured === 'function') {
              const result = configured(requestBody);
              if ('status' in result && 'body' in result) {
                return jsonResponse(result.status, result.body);
              }
              return jsonResponse(201, result);
            }
            if ('status' in configured && 'body' in configured) {
              return jsonResponse(configured.status, configured.body);
            }
            return jsonResponse(201, configured);
          };
          if (options.createDelayMs !== undefined) {
            return new Promise<Response>((resolve) => {
              setTimeout(() => {
                resolve(respond());
              }, options.createDelayMs);
            });
          }
          return Promise.resolve(respond());
        }

        const configured = options.listByHome?.[homeId];
        const respond = () => {
          if (configured === undefined) {
            return jsonResponse(200, {
              items: [],
              hasMore: false,
              nextCursor: null,
            });
          }
          if (typeof configured === 'function') {
            const result = configured(url);
            if ('status' in result && 'body' in result) {
              return jsonResponse(result.status, result.body);
            }
            return jsonResponse(200, result);
          }
          return jsonResponse(200, configured);
        };
        if (options.listDelayMs !== undefined) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(respond());
            }, options.listDelayMs);
          });
        }
        return Promise.resolve(respond());
      }

      const membershipsMatch = /^\/api\/v1\/homes\/([^/]+)\/memberships$/i.exec(
        path,
      );
      if (membershipsMatch?.[1] !== undefined && method === 'GET') {
        const homeId = membershipsMatch[1];
        const configured = options.membershipsByHome?.[homeId];
        if (configured === undefined) {
          return Promise.resolve(jsonResponse(200, defaultMemberships(homeId)));
        }
        if (typeof configured === 'function') {
          const result = configured();
          if ('status' in result && 'body' in result) {
            return Promise.resolve(jsonResponse(result.status, result.body));
          }
          return Promise.resolve(jsonResponse(200, result));
        }
        if ('status' in configured && 'body' in configured) {
          return Promise.resolve(
            jsonResponse(configured.status, configured.body),
          );
        }
        return Promise.resolve(jsonResponse(200, configured));
      }

      const homeMatch = /^\/api\/v1\/homes\/([^/]+)$/i.exec(path);
      if (homeMatch?.[1] !== undefined) {
        const homeId = homeMatch[1];
        const override = options.contexts?.[homeId];
        if (override !== undefined) {
          return Promise.resolve(jsonResponse(override.status, override.body));
        }
        return Promise.resolve(jsonResponse(200, defaultContext(homeId)));
      }

      return Promise.resolve(jsonResponse(404, notFoundBody()));
    });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

import { vi } from 'vitest';
import type {
  MaintenanceDetail,
  MaintenanceListPage,
} from './maintenance-api.js';
import {
  jsonResponse,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
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
  listDelayMs?: number;
  detailDelayMs?: number;
};

function defaultContext(homeId: string): HomeContextBody {
  if (homeId === TEST_HOME_B) {
    return { id: TEST_HOME_B, name: 'Cedar House', timezone: 'UTC' };
  }
  return { id: TEST_HOME_A, name: 'Oak Street', timezone: 'UTC' };
}

export function detailCacheKey(homeId: string, entryId: string): string {
  return `${homeId}:${entryId}`;
}

export function stubMaintenanceApis(options: MaintenanceStubOptions = {}) {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const path = url.pathname;

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

    const detailMatch =
      /^\/api\/v1\/homes\/([^/]+)\/maintenance\/([^/]+)$/i.exec(path);
    if (detailMatch?.[1] !== undefined && detailMatch[2] !== undefined) {
      const homeId = detailMatch[1];
      const entryId = detailMatch[2];
      const configured = options.detailByKey?.[detailCacheKey(homeId, entryId)];
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

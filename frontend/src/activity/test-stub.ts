import { vi } from 'vitest';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { responseForCommonHomeRead } from '../test/common-home-reads.js';
import type { ActivityListPage } from './activity-api.js';
import {
  jsonResponse,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_USER_ID,
  unauthenticatedBody,
} from './test-fixtures.js';

type HomeContextBody = {
  id: string;
  name: string;
  timezone: string;
  hasPhoto: boolean;
};

export type ActivityListResult =
  ActivityListPage | { status: number; body: unknown };

export type ActivityStubOptions = {
  homes?: readonly {
    id: string;
    name: string;
    timezone: string;
    role: 'ADMIN' | 'ROOMMATE';
    hasPhoto: boolean;
  }[];
  contexts?: Record<string, { status: number; body: unknown }>;
  listByHome?: Record<
    string,
    ActivityListResult | ((url: URL) => ActivityListResult)
  >;
  meStatus?: number | (() => number);
  listDelayMs?: number;
  delayedHomeId?: string;
};

function defaultContext(homeId: string): HomeContextBody {
  if (homeId === TEST_HOME_B) {
    return {
      id: TEST_HOME_B,
      name: 'Cedar House',
      timezone: 'UTC',
      hasPhoto: false,
    };
  }
  return {
    id: TEST_HOME_A,
    name: 'Oak Street',
    timezone: 'UTC',
    hasPhoto: false,
  };
}

function resolveListResult(
  configured: ActivityListResult | ((url: URL) => ActivityListResult),
  url: URL,
): Response {
  const result =
    typeof configured === 'function' ? configured(url) : configured;
  if ('status' in result && 'body' in result && !('items' in result)) {
    return jsonResponse(result.status, result.body);
  }
  return jsonResponse(200, result);
}

export function stubActivityApis(options: ActivityStubOptions = {}) {
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
                hasPhoto: false,
                role: 'ADMIN',
              },
              {
                id: TEST_HOME_B,
                name: 'Cedar House',
                timezone: 'UTC',
                hasPhoto: false,
                role: 'ROOMMATE',
              },
            ],
          ),
        );
      }

      if (path.endsWith('/api/v1/me')) {
        const meStatus =
          typeof options.meStatus === 'function'
            ? options.meStatus()
            : (options.meStatus ?? 200);
        if (meStatus === 401) {
          return Promise.resolve(jsonResponse(401, unauthenticatedBody()));
        }
        return Promise.resolve(jsonResponse(200, { id: TEST_USER_ID }));
      }

      const listMatch = /^\/api\/v1\/homes\/([^/]+)\/activity$/i.exec(path);
      if (listMatch?.[1] !== undefined && method === 'GET') {
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
          return resolveListResult(configured, url);
        };
        if (
          options.listDelayMs !== undefined &&
          (options.delayedHomeId === undefined ||
            options.delayedHomeId === homeId)
        ) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(respond());
            }, options.listDelayMs);
          });
        }
        return Promise.resolve(respond());
      }

      const pulseMatch = /^\/api\/v1\/homes\/([^/]+)\/pulse$/i.exec(path);
      if (pulseMatch?.[1] !== undefined && method === 'GET') {
        return Promise.resolve(jsonResponse(200, clearHousePulse()));
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

      const common = responseForCommonHomeRead(path, method);
      if (common !== null) {
        return Promise.resolve(common);
      }

      return Promise.resolve(jsonResponse(404, notFoundBody()));
    });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

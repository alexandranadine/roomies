import { vi } from 'vitest';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import type { NotificationListPage } from './notifications-api.js';
import {
  emptyResponse,
  jsonResponse,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_USER_ID,
  unauthenticatedBody,
} from './test-fixtures.js';

export type NotificationListResult =
  NotificationListPage | { status: number; body: unknown };

export type NotificationStubOptions = {
  homes?: readonly {
    id: string;
    name: string;
    timezone: string;
    role: 'ADMIN' | 'ROOMMATE';
    hasPhoto: boolean;
  }[];
  contexts?: Record<string, { status: number; body: unknown }>;
  list?: NotificationListResult | ((url: URL) => NotificationListResult);
  markOne?:
    | { status: number; body?: unknown }
    | ((notificationId: string) => { status: number; body?: unknown });
  readAll?:
    | { status: number; body?: unknown }
    | (() => { status: number; body?: unknown });
  meStatus?: number | (() => number);
  listDelayMs?: number;
};

function defaultContext(homeId: string): {
  id: string;
  name: string;
  timezone: string;
  hasPhoto: boolean;
} {
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
  configured: NotificationListResult | ((url: URL) => NotificationListResult),
  url: URL,
): Response {
  const result =
    typeof configured === 'function' ? configured(url) : configured;
  if ('status' in result && 'body' in result && !('items' in result)) {
    return jsonResponse(result.status, result.body);
  }
  return jsonResponse(200, result);
}

export function stubNotificationsApis(options: NotificationStubOptions = {}) {
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

      if (path === '/api/v1/notifications' && method === 'GET') {
        const configured = options.list;
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
        if (options.listDelayMs !== undefined) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(respond());
            }, options.listDelayMs);
          });
        }
        return Promise.resolve(respond());
      }

      if (path === '/api/v1/notifications/read-all' && method === 'POST') {
        const configured =
          typeof options.readAll === 'function'
            ? options.readAll()
            : (options.readAll ?? { status: 204 });
        if (configured.status === 204) {
          return Promise.resolve(emptyResponse(204));
        }
        return Promise.resolve(
          jsonResponse(configured.status, configured.body ?? notFoundBody()),
        );
      }

      const markMatch = /^\/api\/v1\/notifications\/([^/]+)\/read$/i.exec(path);
      if (markMatch?.[1] !== undefined && method === 'POST') {
        const notificationId = markMatch[1];
        const configured =
          typeof options.markOne === 'function'
            ? options.markOne(notificationId)
            : (options.markOne ?? { status: 204 });
        if (configured.status === 204) {
          return Promise.resolve(emptyResponse(204));
        }
        return Promise.resolve(
          jsonResponse(configured.status, configured.body ?? notFoundBody()),
        );
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

      return Promise.resolve(jsonResponse(404, notFoundBody()));
    });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

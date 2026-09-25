import { vi } from 'vitest';
import type { ActiveHomeMemberships } from '../homes/home-memberships-api.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { responseForCommonHomeRead } from '../test/common-home-reads.js';
import type { Task, TaskDefinition } from './tasks-api.js';
import {
  jsonResponse,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_USER_ID,
  defaultMemberships,
} from './test-fixtures.js';

type HomeContextBody = {
  id: string;
  name: string;
  timezone: string;
  hasPhoto: boolean;
};

type StatusBody = { status: number; body: unknown };

export type TasksStubOptions = {
  homes?: readonly {
    id: string;
    name: string;
    timezone: string;
    role: 'ADMIN' | 'ROOMMATE';
    hasPhoto: boolean;
  }[];
  contexts?: Record<string, StatusBody>;
  membershipsByHome?: Record<
    string,
    | ActiveHomeMemberships
    | StatusBody
    | (() => ActiveHomeMemberships | StatusBody)
  >;
  listByHome?: Record<
    string,
    Task[] | StatusBody | ((url: URL) => Task[] | StatusBody)
  >;
  definitionsByHome?: Record<
    string,
    TaskDefinition[] | StatusBody | (() => TaskDefinition[] | StatusBody)
  >;
  createByHome?: Record<
    string,
    Task | StatusBody | ((body: unknown) => Task | StatusBody)
  >;
  createDefinitionByHome?: Record<
    string,
    | TaskDefinition
    | StatusBody
    | ((body: unknown) => TaskDefinition | StatusBody)
  >;
  completeByKey?: Record<
    string,
    Task | StatusBody | ((body: unknown) => Task | StatusBody)
  >;
  deactivateByKey?: Record<
    string,
    | TaskDefinition
    | StatusBody
    | ((body: unknown) => TaskDefinition | StatusBody)
  >;
  listDelayMs?: number;
  createDelayMs?: number;
  completeDelayMs?: number;
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

export function taskCacheKey(homeId: string, taskId: string): string {
  return `${homeId}:${taskId}`;
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

function isStatusBody(value: unknown): value is StatusBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'body' in value
  );
}

function delay(ms: number, response: Response): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(response);
    }, ms);
  });
}

export function stubTasksApis(options: TasksStubOptions = {}) {
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
        return Promise.resolve(jsonResponse(200, { id: TEST_USER_ID }));
      }

      const completeMatch =
        /^\/api\/v1\/homes\/([^/]+)\/tasks\/([^/]+)\/complete$/i.exec(path);
      if (
        completeMatch?.[1] !== undefined &&
        completeMatch[2] !== undefined &&
        method === 'POST'
      ) {
        const homeId = completeMatch[1];
        const taskId = completeMatch[2];
        const configured = options.completeByKey?.[taskCacheKey(homeId, taskId)];
        const requestBody = parseRequestBody(init);
        const respond = () => {
          if (configured === undefined) {
            return jsonResponse(404, notFoundBody());
          }
          if (typeof configured === 'function') {
            const result = configured(requestBody);
            if (isStatusBody(result)) {
              return jsonResponse(result.status, result.body);
            }
            return jsonResponse(200, result);
          }
          if (isStatusBody(configured)) {
            return jsonResponse(configured.status, configured.body);
          }
          return jsonResponse(200, configured);
        };
        if (options.completeDelayMs !== undefined) {
          return delay(options.completeDelayMs, respond());
        }
        return Promise.resolve(respond());
      }

      const deactivateMatch =
        /^\/api\/v1\/homes\/([^/]+)\/task-definitions\/([^/]+)\/deactivate$/i.exec(
          path,
        );
      if (
        deactivateMatch?.[1] !== undefined &&
        deactivateMatch[2] !== undefined &&
        method === 'POST'
      ) {
        const homeId = deactivateMatch[1];
        const definitionId = deactivateMatch[2];
        const configured =
          options.deactivateByKey?.[taskCacheKey(homeId, definitionId)];
        const requestBody = parseRequestBody(init);
        if (configured === undefined) {
          return Promise.resolve(jsonResponse(404, notFoundBody()));
        }
        if (typeof configured === 'function') {
          const result = configured(requestBody);
          if (isStatusBody(result)) {
            return Promise.resolve(
              jsonResponse(result.status, result.body),
            );
          }
          return Promise.resolve(jsonResponse(200, result));
        }
        if (isStatusBody(configured)) {
          return Promise.resolve(
            jsonResponse(configured.status, configured.body),
          );
        }
        return Promise.resolve(jsonResponse(200, configured));
      }

      const definitionsMatch =
        /^\/api\/v1\/homes\/([^/]+)\/task-definitions$/i.exec(path);
      if (definitionsMatch?.[1] !== undefined) {
        const homeId = definitionsMatch[1];
        if (method === 'POST') {
          const configured = options.createDefinitionByHome?.[homeId];
          const requestBody = parseRequestBody(init);
          if (configured === undefined) {
            return Promise.resolve(jsonResponse(404, notFoundBody()));
          }
          if (typeof configured === 'function') {
            const result = configured(requestBody);
            if (isStatusBody(result)) {
              return Promise.resolve(
                jsonResponse(result.status, result.body),
              );
            }
            return Promise.resolve(jsonResponse(201, result));
          }
          if (isStatusBody(configured)) {
            return Promise.resolve(
              jsonResponse(configured.status, configured.body),
            );
          }
          return Promise.resolve(jsonResponse(201, configured));
        }

        const configured = options.definitionsByHome?.[homeId];
        if (configured === undefined) {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (typeof configured === 'function') {
          const result = configured();
          if (isStatusBody(result)) {
            return Promise.resolve(
              jsonResponse(result.status, result.body),
            );
          }
          return Promise.resolve(jsonResponse(200, result));
        }
        if (isStatusBody(configured)) {
          return Promise.resolve(
            jsonResponse(configured.status, configured.body),
          );
        }
        return Promise.resolve(jsonResponse(200, configured));
      }

      const listMatch = /^\/api\/v1\/homes\/([^/]+)\/tasks$/i.exec(path);
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
              if (isStatusBody(result)) {
                return jsonResponse(result.status, result.body);
              }
              return jsonResponse(201, result);
            }
            if (isStatusBody(configured)) {
              return jsonResponse(configured.status, configured.body);
            }
            return jsonResponse(201, configured);
          };
          if (options.createDelayMs !== undefined) {
            return delay(options.createDelayMs, respond());
          }
          return Promise.resolve(respond());
        }

        const configured = options.listByHome?.[homeId];
        const respond = () => {
          if (configured === undefined) {
            return jsonResponse(200, []);
          }
          if (typeof configured === 'function') {
            const result = configured(url);
            if (isStatusBody(result)) {
              return jsonResponse(result.status, result.body);
            }
            return jsonResponse(200, result);
          }
          if (isStatusBody(configured)) {
            return jsonResponse(configured.status, configured.body);
          }
          return jsonResponse(200, configured);
        };
        if (
          options.listDelayMs !== undefined &&
          (options.delayedHomeId === undefined ||
            options.delayedHomeId === homeId)
        ) {
          return delay(options.listDelayMs, respond());
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
          if (isStatusBody(result)) {
            return Promise.resolve(
              jsonResponse(result.status, result.body),
            );
          }
          return Promise.resolve(jsonResponse(200, result));
        }
        if (isStatusBody(configured)) {
          return Promise.resolve(
            jsonResponse(configured.status, configured.body),
          );
        }
        return Promise.resolve(jsonResponse(200, configured));
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

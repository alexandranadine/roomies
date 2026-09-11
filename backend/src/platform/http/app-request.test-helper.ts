import http from 'node:http';
import type { Express } from 'express';

export type AppTestResponse = {
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
};

/**
 * Keep one ephemeral HTTP server open for multi-request flows (cookies/session).
 */
export async function withAppServer<T>(
  app: Express,
  run: (
    request: (options: {
      method?: string;
      path: string;
      headers?: Record<string, string>;
      body?: string;
    }) => Promise<AppTestResponse>,
  ) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('expected TCP listen address');
  }

  const request = async (options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<AppTestResponse> => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${options.path}`,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: () => JSON.parse(text) as unknown,
    };
  };

  try {
    return await run(request);
  } finally {
    await closeServer(server);
  }
}

/**
 * Exercise an Express app with fetch against an ephemeral localhost port.
 * Used only by tests — production listening stays in `startHttpServer`.
 */
export async function appRequest(
  app: Express,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<AppTestResponse> {
  return withAppServer(app, (request) => request(options));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

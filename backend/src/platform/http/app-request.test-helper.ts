import http from 'node:http';
import type { Express } from 'express';

export type AppTestResponse = {
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
};

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

  try {
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
  } finally {
    await closeServer(server);
  }
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

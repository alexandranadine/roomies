import http from 'node:http';
import type { Express } from 'express';

export type AppTestResponse = {
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
};

export type AppTestRequestOptions = {
  method?: string;
  path: string;
  headers?: Record<string, string | readonly string[]>;
  body?: string;
  redirect?: 'follow' | 'error' | 'manual';
};

/**
 * Keep one ephemeral HTTP server open for multi-request flows (cookies/session).
 */
export async function withAppServer<T>(
  app: Express,
  run: (
    request: (options: AppTestRequestOptions) => Promise<AppTestResponse>,
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

  const request = async (
    options: AppTestRequestOptions,
  ): Promise<AppTestResponse> => {
    if (headersHaveArrays(options.headers)) {
      return nodeHttpRequest(address.port, options);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}${options.path}`,
      {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        redirect: options.redirect,
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
  options: AppTestRequestOptions,
): Promise<AppTestResponse> {
  return withAppServer(app, (request) => request(options));
}

function headersHaveArrays(
  headers: Record<string, string | readonly string[]> | undefined,
): boolean {
  if (headers === undefined) {
    return false;
  }
  return Object.values(headers).some((value) => Array.isArray(value));
}

function incomingToHeaders(incoming: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function nodeHttpRequest(
  port: number,
  options: AppTestRequestOptions,
): Promise<AppTestResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers as http.OutgoingHttpHeaders | undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: incomingToHeaders(response.headers),
            text,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, resetApiClientForTests } from '../platform/api/index.js';
import {
  deleteHomePhoto,
  finalizeHomePhoto,
  getHomePhotoBlob,
  putHomePhotoObject,
  requestHomePhotoUpload,
} from './home-photo-api.js';
import { HomePhotoTransferError } from './home-photo-errors.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const SIGNED_PUT =
  'https://abc123.r2.cloudflarestorage.com/temp/put?X-Amz-Signature=redacted';
const SIGNED_GET =
  'https://abc123.r2.cloudflarestorage.com/canonical/get?X-Amz-Signature=redacted';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestHomePhotoUpload', () => {
  it('POSTs contentType and byteSize to the upload-intent route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        uploadId: UPLOAD_ID,
        uploadUrl: SIGNED_PUT,
        expiresAt: '2026-09-24T00:00:00.000Z',
        requiredHeaders: { 'Content-Type': 'image/jpeg' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestHomePhotoUpload({
      homeId: HOME_ID,
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${HOME_ID}/photo/uploads`,
    );
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    expect(result.uploadId).toBe(UPLOAD_ID);
    expect(result.requiredHeaders['Content-Type']).toBe('image/jpeg');
  });
});

describe('putHomePhotoObject', () => {
  it('PUTs the file with Content-Type and without credentials or Content-Length', async () => {
    const file = new File([new Uint8Array(8)], 'photo.jpg', {
      type: 'image/jpeg',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await putHomePhotoObject({
      uploadUrl: SIGNED_PUT,
      contentType: 'image/jpeg',
      body: file,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SIGNED_PUT);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe(file);

    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('image/jpeg');
    expect(headers.has('Content-Length')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.has('Cookie')).toBe(false);
    expect(JSON.stringify(init.headers)).not.toMatch(/Content-Length/i);
  });

  it('treats a non-2xx PUT as upload failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('AccessDenied', { status: 403 })),
    );

    await expect(
      putHomePhotoObject({
        uploadUrl: SIGNED_PUT,
        contentType: 'image/png',
        body: new Blob(['x']),
      }),
    ).rejects.toBeInstanceOf(HomePhotoTransferError);
  });
});

describe('finalizeHomePhoto', () => {
  it('POSTs only uploadId and returns the Home DTO', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await finalizeHomePhoto({
      homeId: HOME_ID,
      uploadId: UPLOAD_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_ID}/photo`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ uploadId: UPLOAD_ID });
    expect(result).toEqual({
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: true,
    });
  });
});

describe('getHomePhotoBlob', () => {
  it('returns null on 204 and does not fetch a signed URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHomePhotoBlob(HOME_ID);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_ID}/photo`);
    expect(init.credentials).toBe('include');
  });

  it('fetches the signed URL as a Blob and does not return the URL', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const path = String(url);
        if (path.includes(`/api/v1/homes/${HOME_ID}/photo`)) {
          expect(init?.credentials).toBe('include');
          return Promise.resolve(
            jsonResponse(200, {
              downloadUrl: SIGNED_GET,
              contentType: 'image/webp',
              expiresAt: '2026-09-24T00:01:00.000Z',
            }),
          );
        }
        if (path === SIGNED_GET) {
          return Promise.resolve(
            new Response(bytes, {
              status: 200,
              headers: { 'Content-Type': 'image/webp' },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHomePhotoBlob(HOME_ID);

    expect(result).toBeInstanceOf(Blob);
    expect(result?.size).toBe(4);
    expect(Object.prototype.hasOwnProperty.call(result, 'downloadUrl')).toBe(
      false,
    );
    expect(JSON.stringify(result)).not.toContain(SIGNED_GET);
    expect(JSON.stringify(result)).not.toContain('r2.cloudflarestorage.com');

    const objectCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === SIGNED_GET,
    );
    expect(objectCall).toBeDefined();
    const objectInit = objectCall?.[1] as RequestInit;
    expect(objectInit.credentials).toBe('omit');
    const objectHeaders = new Headers(objectInit.headers);
    expect(objectHeaders.has('Authorization')).toBe(false);
  });
});

describe('deleteHomePhoto', () => {
  it('DELETEs the photo and accepts 204', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteHomePhoto(HOME_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${HOME_ID}/photo`);
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('include');
  });

  it('throws ApiError when delete is not successful', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          error: { code: 'INTERNAL', message: 'Something broke' },
        }),
      ),
    );

    await expect(deleteHomePhoto(HOME_ID)).rejects.toBeInstanceOf(ApiError);
  });
});

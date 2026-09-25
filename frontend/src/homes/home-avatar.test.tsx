import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { renderApp } from '../test/render.js';
import { responseForCommonHomeRead } from '../test/common-home-reads.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIGNED_GET =
  'https://abc123.r2.cloudflarestorage.com/canonical/get?X-Amz-Signature=redacted';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubHomeWithPhoto(options: {
  photoStatus?: number;
  objectStatus?: number;
}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    if (path.endsWith('/api/v1/me')) {
      return Promise.resolve(jsonResponse(200, { id: USER_ID }));
    }
    if (path.includes('/api/v1/me/homes')) {
      return Promise.resolve(
        jsonResponse(200, [
          {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
            hasPhoto: true,
            role: 'ROOMMATE',
          },
        ]),
      );
    }
    if (path.includes(`/api/v1/homes/${HOME_A}/pulse`)) {
      return Promise.resolve(jsonResponse(200, clearHousePulse()));
    }
    if (path.includes(`/api/v1/homes/${HOME_A}/photo`)) {
      if ((options.photoStatus ?? 200) !== 200) {
        return Promise.resolve(
          jsonResponse(options.photoStatus ?? 500, {
            error: { code: 'INTERNAL', message: 'boom' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          downloadUrl: SIGNED_GET,
          contentType: 'image/webp',
          expiresAt: '2026-09-24T00:01:00.000Z',
        }),
      );
    }
    if (path === SIGNED_GET) {
      if ((options.objectStatus ?? 200) !== 200) {
        return Promise.resolve(new Response('denied', { status: 403 }));
      }
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        }),
      );
    }
    if (path.match(new RegExp(`/api/v1/homes/${HOME_A}$`))) {
      return Promise.resolve(
        jsonResponse(200, {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          hasPhoto: true,
        }),
      );
    }
    const common = responseForCommonHomeRead(path, 'GET');
    if (common !== null) {
      return Promise.resolve(common);
    }
    return Promise.resolve(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HomeAvatar', () => {
  it('falls back to the Home initial when there is no photo', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.endsWith('/api/v1/me')) {
        return Promise.resolve(jsonResponse(200, { id: USER_ID }));
      }
      if (path.includes('/api/v1/me/homes')) {
        return Promise.resolve(
          jsonResponse(200, [
            {
              id: HOME_A,
              name: 'Oak Street',
              timezone: 'UTC',
              hasPhoto: false,
              role: 'ADMIN',
            },
          ]),
        );
      }
      if (path.includes(`/api/v1/homes/${HOME_A}/pulse`)) {
        return Promise.resolve(jsonResponse(200, clearHousePulse()));
      }
      if (path.match(new RegExp(`/api/v1/homes/${HOME_A}$`))) {
        return Promise.resolve(
          jsonResponse(200, {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
            hasPhoto: false,
          }),
        );
      }
      const common = responseForCommonHomeRead(path, 'GET');
      if (common !== null) {
        return Promise.resolve(common);
      }
      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Oak Street photo' })).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/photo')),
    ).toBe(false);
  });

  it('renders the fetched Blob photo and falls back when the object fetch fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-home-photo');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    stubHomeWithPhoto({});

    renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findAllByRole('img', { name: 'Oak Street photo' }),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole('img', { name: 'Oak Street photo' })[0],
    ).toHaveAttribute('src', 'blob:test-home-photo');
    expect(document.body.innerHTML).not.toContain(SIGNED_GET);
  });

  it('falls back to the Home initial when photo download fails', async () => {
    stubHomeWithPhoto({ objectStatus: 403 });
    renderApp(`/homes/${HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('img', { name: 'Oak Street photo' }),
      ).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain('AccessDenied');
    expect(document.body.innerHTML).not.toContain(SIGNED_GET);
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { renderApp } from '../test/render.js';
import { responseForCommonHomeRead } from '../test/common-home-reads.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
  homePhotoQueryKey,
} from './home-query-keys.js';
import {
  HOME_PHOTO_MAX_BYTES,
  HOME_PHOTO_OVERSIZE_MESSAGE,
  HOME_PHOTO_UNSUPPORTED_MESSAGE,
} from './home-photo-validation.js';
import { HOME_PHOTO_INVALID_IMAGE_MESSAGE } from './home-photo-errors.js';
import {
  HOME_PHOTO_REMOVED_MESSAGE,
  HOME_PHOTO_UPDATED_MESSAGE,
} from './home-photo-section.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const SIGNED_PUT =
  'https://abc123.r2.cloudflarestorage.com/temp/put?X-Amz-Signature=redacted';
const SIGNED_GET_V1 =
  'https://abc123.r2.cloudflarestorage.com/canonical/v1?X-Amz-Signature=redacted';
const SIGNED_GET_V2 =
  'https://abc123.r2.cloudflarestorage.com/canonical/v2?X-Amz-Signature=redacted';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function photoFile(type: string, size: number, name = 'photo.jpg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

type StubOptions = {
  role: 'ADMIN' | 'ROOMMATE';
  hasPhoto: boolean;
  finalizeStatus?: number;
  deleteStatus?: number;
  putDelayMs?: number;
  photoGenerations?: Uint8Array<ArrayBuffer>[];
};

function stubPhotoHome(options: StubOptions) {
  let hasPhoto = options.hasPhoto;
  let photoGeneration = 0;
  const generations: Uint8Array<ArrayBuffer>[] = options.photoGenerations ?? [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([9, 9, 9, 9, 9]),
  ];

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();

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
              hasPhoto,
              role: options.role,
            },
          ]),
        );
      }
      if (path.includes(`/api/v1/homes/${HOME_A}/pulse`)) {
        return Promise.resolve(jsonResponse(200, clearHousePulse()));
      }
      if (
        path.includes(`/api/v1/homes/${HOME_A}/photo/uploads`) &&
        method === 'POST'
      ) {
        return Promise.resolve(
          jsonResponse(201, {
            uploadId: UPLOAD_ID,
            uploadUrl: SIGNED_PUT,
            expiresAt: '2026-09-24T00:05:00.000Z',
            requiredHeaders: { 'Content-Type': 'image/jpeg' },
          }),
        );
      }
      if (path === SIGNED_PUT && method === 'PUT') {
        const delay = options.putDelayMs ?? 0;
        const response = new Response(null, { status: 200 });
        if (delay === 0) {
          return Promise.resolve(response);
        }
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(response);
          }, delay);
        });
      }
      if (
        path.includes(`/api/v1/homes/${HOME_A}/photo`) &&
        method === 'POST' &&
        !path.includes('/uploads')
      ) {
        const status = options.finalizeStatus ?? 200;
        if (status !== 200) {
          return Promise.resolve(
            jsonResponse(status, {
              error: {
                code: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL',
                message: 'object key homes/oak/photo failed in sharp',
              },
            }),
          );
        }
        hasPhoto = true;
        photoGeneration += 1;
        return Promise.resolve(
          jsonResponse(200, {
            id: HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
            hasPhoto: true,
          }),
        );
      }
      if (
        path.includes(`/api/v1/homes/${HOME_A}/photo`) &&
        method === 'DELETE'
      ) {
        const status = options.deleteStatus ?? 204;
        if (status !== 204) {
          return Promise.resolve(
            jsonResponse(status, {
              error: { code: 'INTERNAL', message: 'delete failed' },
            }),
          );
        }
        hasPhoto = false;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.includes(`/api/v1/homes/${HOME_A}/photo`) && method === 'GET') {
        if (!hasPhoto) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const signed = photoGeneration === 0 ? SIGNED_GET_V1 : SIGNED_GET_V2;
        return Promise.resolve(
          jsonResponse(200, {
            downloadUrl: signed,
            contentType: 'image/webp',
            expiresAt: '2026-09-24T00:01:00.000Z',
          }),
        );
      }
      if (path === SIGNED_GET_V1 || path === SIGNED_GET_V2) {
        const bytes =
          path === SIGNED_GET_V2
            ? (generations[1] ?? generations[0] ?? new Uint8Array([2]))
            : (generations[0] ?? new Uint8Array([1]));
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
          }),
        );
      }
      if (
        path.match(new RegExp(`/api/v1/homes/${HOME_A}$`)) &&
        method === 'GET'
      ) {
      return Promise.resolve(
        jsonResponse(200, {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          hasPhoto,
        }),
      );
    }
      const common = responseForCommonHomeRead(path, method);
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
  return fetchMock;
}

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Home photo management', () => {
  async function openPhotoDialog() {
    await userEvent.click(
      await screen.findByRole('button', { name: 'Home photo' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Home photo' }),
    ).toBeInTheDocument();
  }

  it('lets a Roommate add, change, and remove a photo without Admin-only copy', async () => {
    stubPhotoHome({ role: 'ROOMMATE', hasPhoto: false });
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    expect(
      screen.getByRole('button', { name: 'Add photo' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/admin-only|admins only/i);
  });

  it('lets a Home Admin use the same add/change/remove controls', async () => {
    stubPhotoHome({ role: 'ADMIN', hasPhoto: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:committed');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();

    expect(
      await screen.findByRole('button', { name: 'Change photo' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove photo' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add photo' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/admin-only|admins only/i);
  });

  it('reports unsupported and oversized local files without uploading', async () => {
    const fetchMock = stubPhotoHome({ role: 'ROOMMATE', hasPhoto: false });
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    const input = await screen.findByLabelText('Choose a Home photo');

    await userEvent.upload(input, photoFile('image/heic', 32, 'photo.heic'), {
      applyAccept: false,
    });
    expect(
      await screen.findByText(HOME_PHOTO_UNSUPPORTED_MESSAGE),
    ).toBeInTheDocument();

    await userEvent.upload(
      input,
      photoFile('image/jpeg', HOME_PHOTO_MAX_BYTES + 1),
    );
    expect(
      await screen.findByText(HOME_PHOTO_OVERSIZE_MESSAGE),
    ).toBeInTheDocument();

    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes('/photo/uploads'),
      ),
    ).toBe(false);
  });

  it('disables duplicate actions while uploading', async () => {
    stubPhotoHome({ role: 'ROOMMATE', hasPhoto: false, putDelayMs: 150 });
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    const input = await screen.findByLabelText('Choose a Home photo');

    await userEvent.upload(input, photoFile('image/jpeg', 16));

    expect(await screen.findByText('Uploading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeDisabled();
    expect(input).toBeDisabled();
  });

  it('keeps the committed photo when finalize fails', async () => {
    stubPhotoHome({
      role: 'ROOMMATE',
      hasPhoto: true,
      finalizeStatus: 400,
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      (blob) => `blob:size:${(blob as Blob).size}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    expect(
      await screen.findAllByRole('img', { name: 'Oak Street photo' }),
    ).not.toHaveLength(0);

    await userEvent.upload(
      screen.getByLabelText('Choose a Home photo'),
      photoFile('image/jpeg', 32),
    );

    expect(
      await screen.findByText(HOME_PHOTO_INVALID_IMAGE_MESSAGE),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('img', { name: 'Oak Street photo' })[0],
    ).toHaveAttribute('src', 'blob:size:4');
    expect(document.body.textContent).not.toContain(SIGNED_PUT);
    expect(document.body.textContent).not.toMatch(/sharp|object key/i);
  });

  it('keeps the photo visible when remove fails', async () => {
    stubPhotoHome({
      role: 'ADMIN',
      hasPhoto: true,
      deleteStatus: 500,
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:committed');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove photo' }),
    );

    expect(
      await screen.findByText(
        'Something went wrong while updating the Home photo. Try again.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('img', { name: 'Oak Street photo' })[0],
    ).toHaveAttribute('src', 'blob:committed');
  });

  it('invalidates Home, homes list, and photo queries after the first successful upload', async () => {
    const fetchMock = stubPhotoHome({ role: 'ROOMMATE', hasPhoto: false });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      (blob) => `blob:size:${(blob as Blob).size}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { queryClient } = renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    await screen.findByLabelText('Choose a Home photo');
    queryClient.setQueryData(currentUserHomesQueryKey, [
      {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
        role: 'ROOMMATE' as const,
      },
    ]);

    await userEvent.upload(
      await screen.findByLabelText('Choose a Home photo'),
      photoFile('image/jpeg', 16),
    );

    expect(
      await screen.findByText(HOME_PHOTO_UPDATED_MESSAGE),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        queryClient.getQueryData(homeContextQueryKey(HOME_A)),
      ).toMatchObject({
        hasPhoto: true,
      });
    });
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes('/photo/uploads'),
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(
        queryClient.getQueryData(homePhotoQueryKey(HOME_A)),
      ).toBeInstanceOf(Blob);
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: HOME_A, hasPhoto: true }),
        ]),
      );
    });
  });

  it('refreshes the photo Blob after replacement even when hasPhoto stays true', async () => {
    const fetchMock = stubPhotoHome({ role: 'ADMIN', hasPhoto: true });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      (blob) => `blob:size:${(blob as Blob).size}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();

    expect(
      await screen.findAllByRole('img', { name: 'Oak Street photo' }),
    ).not.toHaveLength(0);

    const photoGetsBefore = fetchMock.mock.calls.filter(
      (call) =>
        String(call[0]).includes(`/api/v1/homes/${HOME_A}/photo`) &&
        String(call[0]).includes('localhost') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET') !== 'POST' &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET') !== 'DELETE',
    ).length;

    await userEvent.upload(
      screen.getByLabelText('Choose a Home photo'),
      photoFile('image/jpeg', 24),
    );

    expect(
      await screen.findByText(HOME_PHOTO_UPDATED_MESSAGE),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getAllByRole('img', { name: 'Oak Street photo' })[0],
      ).toHaveAttribute('src', 'blob:size:5');
    });

    const photoGetsAfter = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const method = (call[1] as RequestInit | undefined)?.method ?? 'GET';
      return (
        url.includes(`/api/v1/homes/${HOME_A}/photo`) &&
        !url.includes('/uploads') &&
        method === 'GET'
      );
    }).length;
    expect(photoGetsAfter).toBeGreaterThan(photoGetsBefore);
  });

  it('clears the photo after a successful delete', async () => {
    stubPhotoHome({ role: 'ROOMMATE', hasPhoto: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:committed');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { queryClient } = renderApp(`/homes/${HOME_A}`);
    await openPhotoDialog();
    queryClient.setQueryData(currentUserHomesQueryKey, [
      {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: true,
        role: 'ROOMMATE' as const,
      },
    ]);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove photo' }),
    );

    expect(
      await screen.findByText(HOME_PHOTO_REMOVED_MESSAGE),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add photo' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull();
    await waitFor(() => {
      expect(
        queryClient.getQueryData(homeContextQueryKey(HOME_A)),
      ).toMatchObject({
        hasPhoto: false,
      });
    });
    expect(
      queryClient.getQueryData(homePhotoQueryKey(HOME_A)) ?? null,
    ).toBeNull();
    await waitFor(() => {
      expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: HOME_A, hasPhoto: false }),
        ]),
      );
    });
  });
});

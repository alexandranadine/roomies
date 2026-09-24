import type { HomePhotoObjectStore } from '../../platform/object-store/index.js';

/**
 * Best-effort object deletion. Failures must not undo a committed pointer and
 * must not leak keys to clients.
 */
export async function bestEffortDeleteHomePhotoObject(
  objectStore: Pick<HomePhotoObjectStore, 'deleteObject'>,
  key: string | null,
): Promise<void> {
  if (key === null) {
    return;
  }
  try {
    await objectStore.deleteObject({ key });
  } catch {
    console.error('[homes] photo object cleanup failed');
  }
}

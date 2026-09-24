import type { AppConfig } from '../config/types.js';
import { createCloudflareR2ObjectStore } from './cloudflare-r2.js';
import { createFakeHomePhotoObjectStore } from './fake-store.js';
import type { HomePhotoObjectStore } from './types.js';

/**
 * Build the configured Home-photo object store. Production never receives `fake`.
 */
export function createHomePhotoObjectStore(
  config: Pick<AppConfig, 'appEnv' | 'objectStore'>,
): HomePhotoObjectStore {
  const objectStore = config.objectStore ?? { provider: 'fake' as const };
  if (config.appEnv === 'production' && objectStore.provider !== 'cloudflare') {
    throw new Error('Production object store adapter must be cloudflare');
  }
  if (objectStore.provider === 'cloudflare') {
    return createCloudflareR2ObjectStore({ config: objectStore });
  }
  return createFakeHomePhotoObjectStore();
}

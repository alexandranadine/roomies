import { getHome } from '../../domains/homes/get-home.js';
import type { Home } from '../../domains/homes/home.js';
import { isCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import {
  HOME_PHOTO_WEBP_CONTENT_TYPE,
  type HomePhotoObjectStore,
} from '../../platform/object-store/index.js';

export type GetHomePhotoInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
}>;

export type HomePhotoDownload = Readonly<{
  downloadUrl: string;
  contentType: typeof HOME_PHOTO_WEBP_CONTENT_TYPE;
  expiresAt: Date;
}>;

export type GetHomePhotoDependencies = Readonly<{
  homes: {
    findActiveHomeById(homeId: string): Promise<Home | null>;
  };
  objectStore: Pick<HomePhotoObjectStore, 'createPresignedGet'>;
}>;

/**
 * Authorized current-photo download. A Home with no photo returns null (HTTP
 * 204). Invalid stored keys fail closed without minting a signed URL.
 */
export function createGetHomePhoto(
  deps: GetHomePhotoDependencies,
): (input: GetHomePhotoInput) => Promise<HomePhotoDownload | null> {
  return async (input) => {
    const home = await getHome(
      { actor: input.actor, homeId: input.homeId },
      deps.homes,
    );
    if (home.photoObjectKey === null) {
      return null;
    }
    if (!isCanonicalHomePhotoObjectKey(home.photoObjectKey, home.id)) {
      throw new AuthorizationIntegrityError();
    }

    const signed = await deps.objectStore.createPresignedGet({
      homeId: home.id,
      key: home.photoObjectKey,
    });

    return Object.freeze({
      downloadUrl: signed.url,
      contentType: signed.responseContentType,
      expiresAt: signed.expiresAt,
    });
  };
}

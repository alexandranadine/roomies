import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { DeleteHomePhotoInput } from '../../application/homes/delete-home-photo.js';
import type { FinalizeHomePhotoInput } from '../../application/homes/finalize-home-photo.js';
import type { GetHomePhotoInput } from '../../application/homes/get-home-photo.js';
import type { RequestHomePhotoUploadInput } from '../../application/homes/request-home-photo-upload.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  PayloadTooLargeError,
  type ActiveHomeActorResolver,
} from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid, pathUuidSchema } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';
import {
  ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  type AcceptedHomePhotoUploadContentType,
} from '../../platform/object-store/index.js';
import type { Home } from './home.js';
import { toHomeDto, type HomeDto } from './home-dto.js';
import type { HomePhotoDownload } from '../../application/homes/get-home-photo.js';
import type { RequestHomePhotoUploadResult } from '../../application/homes/request-home-photo-upload.js';
import {
  toHomePhotoDownloadDto,
  toHomePhotoUploadIntentDto,
} from './photo-dto.js';

const requestUploadBodySchema = z
  .object({
    contentType: z.enum(ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES),
    byteSize: z.number().int().min(1),
  })
  .strict();

const finalizePhotoBodySchema = z
  .object({
    uploadId: pathUuidSchema,
  })
  .strict();

const deletePhotoBodySchema = z.object({}).strict();

export type RequestHomePhotoUploadCommand = (
  input: RequestHomePhotoUploadInput,
) => Promise<RequestHomePhotoUploadResult>;

export type FinalizeHomePhotoCommand = (
  input: FinalizeHomePhotoInput,
) => Promise<Home>;

export type GetHomePhotoCommand = (
  input: GetHomePhotoInput,
) => Promise<HomePhotoDownload | null>;

export type DeleteHomePhotoCommand = (
  input: DeleteHomePhotoInput,
) => Promise<void>;

export type CreateHomePhotoRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  requestHomePhotoUpload: RequestHomePhotoUploadCommand;
  finalizeHomePhoto: FinalizeHomePhotoCommand;
  getHomePhoto: GetHomePhotoCommand;
  deleteHomePhoto: DeleteHomePhotoCommand;
  rateLimitSensitive?: RequestHandler;
};

function parseRequestUploadBody(body: unknown): {
  contentType: AcceptedHomePhotoUploadContentType;
  byteSize: number;
} {
  const parsed = requestUploadBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  if (parsed.data.byteSize > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError();
  }
  return parsed.data;
}

function parseFinalizePhotoBody(body: unknown): { uploadId: string } {
  const parsed = finalizePhotoBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  return { uploadId: parsed.data.uploadId.toLowerCase() };
}

function parseDeletePhotoBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  if (!deletePhotoBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

/**
 * Authenticated Home-photo routes. Mount at `/homes` on the v1 router.
 * Sensitive-operation rate limiting, when provided, applies to upload intent,
 * finalize, and delete — not GET.
 */
export function createHomePhotoRouter(
  options: CreateHomePhotoRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  if (options.rateLimitSensitive !== undefined) {
    router.post('/:homeId/photo/uploads', options.rateLimitSensitive);
    router.post('/:homeId/photo', options.rateLimitSensitive);
    router.delete('/:homeId/photo', options.rateLimitSensitive);
  }
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.post('/:homeId/photo/uploads', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseRequestUploadBody(req.body);
      const result = await options.requestHomePhotoUpload({
        actor,
        homeId,
        contentType: body.contentType,
      });
      res.status(201).json(toHomePhotoUploadIntentDto(result));
    })().catch(next);
  });

  router.post('/:homeId/photo', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseFinalizePhotoBody(req.body);
      const home = await options.finalizeHomePhoto({
        actor,
        homeId,
        uploadId: body.uploadId,
      });
      const dto: HomeDto = toHomeDto(home);
      res.status(200).json(dto);
    })().catch(next);
  });

  router.get('/:homeId/photo', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const download = await options.getHomePhoto({ actor, homeId });
      if (download === null) {
        res.status(204).end();
        return;
      }
      res.status(200).json(toHomePhotoDownloadDto(download));
    })().catch(next);
  });

  router.delete('/:homeId/photo', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      parseDeletePhotoBody(req.body);
      await options.deleteHomePhoto({ actor, homeId });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

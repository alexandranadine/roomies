import { z } from 'zod';
import {
  ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES,
  HOME_PHOTO_WEBP_CONTENT_TYPE,
  type AcceptedHomePhotoUploadContentType,
} from '../../platform/object-store/index.js';

export const homePhotoUploadIntentDtoSchema = z
  .object({
    uploadId: z.string().min(1),
    uploadUrl: z.string().min(1),
    expiresAt: z.string().min(1),
    requiredHeaders: z
      .object({
        'Content-Type': z.enum(ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES),
      })
      .strict(),
  })
  .strict();

export type HomePhotoUploadIntentDto = z.infer<
  typeof homePhotoUploadIntentDtoSchema
>;

export const homePhotoDownloadDtoSchema = z
  .object({
    downloadUrl: z.string().min(1),
    contentType: z.literal(HOME_PHOTO_WEBP_CONTENT_TYPE),
    expiresAt: z.string().min(1),
  })
  .strict();

export type HomePhotoDownloadDto = z.infer<typeof homePhotoDownloadDtoSchema>;

export function toHomePhotoUploadIntentDto(input: {
  uploadId: string;
  uploadUrl: string;
  expiresAt: Date;
  contentType: AcceptedHomePhotoUploadContentType;
}): HomePhotoUploadIntentDto {
  return homePhotoUploadIntentDtoSchema.parse({
    uploadId: input.uploadId,
    uploadUrl: input.uploadUrl,
    expiresAt: input.expiresAt.toISOString(),
    requiredHeaders: {
      'Content-Type': input.contentType,
    },
  });
}

export function toHomePhotoDownloadDto(input: {
  downloadUrl: string;
  contentType: typeof HOME_PHOTO_WEBP_CONTENT_TYPE;
  expiresAt: Date;
}): HomePhotoDownloadDto {
  return homePhotoDownloadDtoSchema.parse({
    downloadUrl: input.downloadUrl,
    contentType: input.contentType,
    expiresAt: input.expiresAt.toISOString(),
  });
}

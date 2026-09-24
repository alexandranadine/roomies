import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Alert, Button } from '../components/ui/index.js';
import type { HomeContext } from './home-context-api.js';
import { deleteHomePhoto, uploadHomePhoto } from './home-photo-api.js';
import {
  clearHomePhotoAfterDelete,
  syncHomePhotoCaches,
} from './home-photo-cache.js';
import { homePhotoErrorMessage } from './home-photo-errors.js';
import {
  HOME_PHOTO_FILE_ACCEPT,
  HomePhotoValidationError,
  validateHomePhotoFile,
} from './home-photo-validation.js';
import { HomeAvatar } from './home-avatar.js';
import { useBlobObjectUrl } from './use-blob-object-url.js';

export const HOME_PHOTO_UPDATED_MESSAGE = 'Home photo updated.';
export const HOME_PHOTO_REMOVED_MESSAGE = 'Home photo removed.';

export type HomePhotoSectionProps = {
  home: HomeContext;
};

/**
 * Compact Home-photo add/change/remove controls. Available to any active
 * Roommate or Admin — not an Admin-only surface.
 */
export function HomePhotoSection({ home }: HomePhotoSectionProps) {
  const headingId = useId();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const previewUrl = useBlobObjectUrl(previewFile);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'danger';
    text: string;
  } | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadHomePhoto({ homeId: home.id, file }),
    onSuccess: async (nextHome) => {
      setPreviewFile(null);
      await syncHomePhotoCaches(queryClient, nextHome);
      setFeedback({ kind: 'success', text: HOME_PHOTO_UPDATED_MESSAGE });
    },
    onError: (error) => {
      setPreviewFile(null);
      setFeedback({ kind: 'danger', text: homePhotoErrorMessage(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteHomePhoto(home.id),
    onSuccess: async () => {
      await clearHomePhotoAfterDelete(queryClient, home.id);
      setFeedback({ kind: 'success', text: HOME_PHOTO_REMOVED_MESSAGE });
    },
    onError: (error) => {
      setFeedback({ kind: 'danger', text: homePhotoErrorMessage(error) });
    },
  });

  const busy = uploadMutation.isPending || deleteMutation.isPending;

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function onFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) {
      return;
    }

    setFeedback(null);
    try {
      validateHomePhotoFile(file);
    } catch (error) {
      setPreviewFile(null);
      if (error instanceof HomePhotoValidationError) {
        setFeedback({ kind: 'danger', text: error.message });
        return;
      }
      setFeedback({ kind: 'danger', text: homePhotoErrorMessage(error) });
      return;
    }

    setPreviewFile(file);
    uploadMutation.mutate(file);
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2
          id={headingId}
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          Home photo
        </h2>
        <p className="max-w-prose text-sm text-text-secondary">
          JPEG, PNG, or WebP. Up to 8 MB.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <HomeAvatar
          homeId={home.id}
          name={home.name}
          hasPhoto={home.hasPhoto}
          size="lg"
        />
        {previewUrl !== null ? (
          <img
            src={previewUrl}
            alt=""
            className="size-12 shrink-0 rounded-lg object-cover opacity-80"
          />
        ) : null}
        {busy ? (
          <p className="text-sm text-text-secondary">
            {deleteMutation.isPending ? 'Removing photo' : 'Uploading'}
          </p>
        ) : null}
      </div>

      <input
        id={fileInputId}
        ref={fileInputRef}
        type="file"
        accept={HOME_PHOTO_FILE_ACCEPT}
        aria-label="Choose a Home photo"
        className="sr-only"
        disabled={busy}
        onChange={onFileSelected}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          loading={uploadMutation.isPending}
          onClick={openFilePicker}
        >
          {home.hasPhoto ? 'Change photo' : 'Add photo'}
        </Button>
        {home.hasPhoto ? (
          <Button
            type="button"
            variant="subtle"
            disabled={busy}
            loading={deleteMutation.isPending}
            onClick={() => {
              setFeedback(null);
              deleteMutation.mutate();
            }}
          >
            Remove photo
          </Button>
        ) : null}
      </div>

      {feedback !== null ? (
        <Alert variant={feedback.kind}>{feedback.text}</Alert>
      ) : null}
    </section>
  );
}

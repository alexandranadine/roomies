import { Dialog } from '../components/ui/index.js';
import type { HomeContext } from './home-context-api.js';
import { HomePhotoSection } from './home-photo-section.js';

export type HomePhotoDialogProps = {
  home: HomeContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Existing Home photo controls in a dialog. Upload/R2 behavior is unchanged.
 */
export function HomePhotoDialog({
  home,
  open,
  onOpenChange,
}: HomePhotoDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Popup
        title="Home photo"
        description="JPEG, PNG, or WebP. Up to 8 MB."
        closeLabel="Close Home photo"
      >
        <HomePhotoSection home={home} embedded />
      </Dialog.Popup>
    </Dialog.Root>
  );
}

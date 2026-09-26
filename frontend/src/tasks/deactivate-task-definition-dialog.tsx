import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { useDeactivateTaskDefinition } from './use-deactivate-task-definition.js';

const DEACTIVATE_ERROR =
  'Couldn’t stop repeating task. Try again.';
const DEACTIVATE_UNAVAILABLE_ERROR =
  'This Home isn’t available right now. Try again later.';

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

export type DeactivateTaskDefinitionDialogProps = {
  homeId: string;
  taskDefinitionId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DeactivateTaskDefinitionDialog({
  homeId,
  taskDefinitionId,
  title,
  open,
  onOpenChange,
}: DeactivateTaskDefinitionDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const deactivateMutation = useDeactivateTaskDefinition();
  const isPending = deactivateMutation.isPending;

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      deactivateMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    deactivateMutation.reset();
    try {
      await deactivateMutation.mutateAsync({
        homeId,
        taskDefinitionId,
      });
      onOpenChange(false);
    } catch (error) {
      if (isConcealedScope(error)) {
        setErrorMessage(DEACTIVATE_UNAVAILABLE_ERROR);
        return;
      }
      setErrorMessage(DEACTIVATE_ERROR);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Stop repeating?"
        description={`Stop adding new “${title}” tasks? Existing tasks stay.`}
        closeLabel="Close stop repeating"
        showCloseButton={!isPending}
      >
        <div className="flex flex-col gap-4">
          {errorMessage ? <Alert variant="danger">{errorMessage}</Alert> : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              loading={isPending}
              disabled={isPending}
              onClick={() => {
                void handleConfirm();
              }}
            >
              Stop repeating
            </Button>
            <Button
              type="button"
              variant="subtle"
              disabled={isPending}
              onClick={() => {
                handleOpenChange(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Root>
  );
}

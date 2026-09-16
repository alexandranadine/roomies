import { useState } from 'react';
import { DocumentTitle } from '../components/document-title.js';
import { Button } from '../components/ui/index.js';
import { DeleteAccountDialog } from './delete-account-dialog.js';

/**
 * Account settings for the signed-in person across Homes.
 * Destructive account actions live here — not in Home settings.
 */
export function AccountSettingsPage() {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <DocumentTitle title="Account · Roomies">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Account
          </h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Manage your Roomies account across your Homes.
          </p>
        </header>

        <section
          aria-labelledby="account-danger-heading"
          className="flex flex-col gap-3 border-t border-border pt-6"
        >
          <div className="flex flex-col gap-1">
            <h2
              id="account-danger-heading"
              className="text-lg font-semibold tracking-tight text-text-primary"
            >
              Delete account
            </h2>
            <p className="max-w-prose text-sm text-text-secondary">
              Permanently remove your Roomies account. This can’t be undone by
              signing back in.
            </p>
          </div>
          <div>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              Delete account
            </Button>
          </div>
        </section>

        <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
      </div>
    </DocumentTitle>
  );
}

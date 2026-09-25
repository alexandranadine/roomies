import { useState } from 'react';
import { SignOutButton } from '../auth/sign-out-button.js';
import { DocumentTitle } from '../components/document-title.js';
import { Button } from '../components/ui/index.js';
import { AccountProfileSection } from './account-profile-section.js';
import { DeleteAccountDialog } from './delete-account-dialog.js';

/**
 * Account settings for the signed-in person across Homes.
 * Destructive account actions live here — not in Home settings.
 */
export function AccountSettingsPage() {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <DocumentTitle title="Account · Roomies">
      <div
        data-testid="account-page"
        className="mx-auto flex w-full max-w-[800px] flex-col gap-6"
      >
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Account
          </h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Manage your Roomies account across your Homes.
          </p>
        </header>

        <AccountProfileSection />

        <section
          aria-labelledby="account-session-heading"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <h2
              id="account-session-heading"
              className="text-base font-semibold tracking-tight text-text-primary"
            >
              Sign out
            </h2>
            <p className="max-w-prose text-sm text-text-secondary">
              End this session on this browser. You can sign in again with the
              same account.
            </p>
          </div>
          <SignOutButton className="self-start" />
        </section>

        <section
          aria-labelledby="account-danger-heading"
          className="flex flex-col gap-3 border-t border-border pt-5"
        >
          <div className="flex flex-col gap-1">
            <h2
              id="account-danger-heading"
              className="text-base font-semibold tracking-tight text-text-primary"
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
              variant="danger-muted"
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

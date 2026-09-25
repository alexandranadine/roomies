import { useQuery } from '@tanstack/react-query';
import { Home } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { AuthIconWell } from '../auth/auth-page-layout.js';
import { DocumentTitle } from '../components/document-title.js';
import { Button, Card, Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { CreateHomeForm } from './create-home-form.js';
import { HomeAvatar } from './home-avatar.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { homeRoleLabel } from './home-role-label.js';
import { listCurrentUserHomes } from './homes-api.js';

export function HomeDiscoveryPage() {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const homesQuery = useQuery({
    queryKey: currentUserHomesQueryKey,
    queryFn: ({ signal }) => listCurrentUserHomes(signal),
  });

  if (homesQuery.isPending) {
    return (
      <DocumentTitle title="Your Homes · Roomies">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Your Homes
          </h1>
          <Spinner label="Loading your Homes" />
        </div>
      </DocumentTitle>
    );
  }

  if (homesQuery.error instanceof ApiError && homesQuery.error.status === 401) {
    return null;
  }

  if (homesQuery.error !== null || homesQuery.data === undefined) {
    return (
      <DocumentTitle title="Your Homes · Roomies">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Your Homes
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            Couldn’t load your Homes. Try again in a moment.
          </p>
        </div>
      </DocumentTitle>
    );
  }

  const homes = homesQuery.data;

  if (homes.length === 0) {
    return (
      <DocumentTitle title="Welcome to Roomies">
        <div className="flex justify-center py-2 sm:py-6">
          <Card
            padding="lg"
            className="flex w-full max-w-lg flex-col gap-5"
          >
            {showCreateForm ? (
              <>
                <AuthIconWell>
                  <Home className="size-6" />
                </AuthIconWell>
                <div className="flex flex-col gap-1">
                  <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                    Create your home
                  </h1>
                  <p className="text-sm text-text-secondary">
                    Give your household a name. You can change it later.
                  </p>
                </div>
                <CreateHomeForm />
              </>
            ) : (
              <>
                <AuthIconWell>
                  <Home className="size-6" />
                </AuthIconWell>
                <div className="flex flex-col gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                    Welcome to Roomies
                  </h1>
                  <p className="text-sm text-text-secondary">
                    Create a home to start coordinating with your roommates. If
                    you were invited, open the invitation link you received.
                  </p>
                </div>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => setShowCreateForm(true)}
                >
                  Create a home
                </Button>
              </>
            )}
          </Card>
        </div>
      </DocumentTitle>
    );
  }

  if (homes.length === 1) {
    const onlyHome = homes[0];
    if (onlyHome === undefined) {
      return null;
    }
    return <Navigate to={`/homes/${onlyHome.id}`} replace />;
  }

  return (
    <DocumentTitle title="Your Homes · Roomies">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Your Homes
        </h1>
        <p className="max-w-prose text-base text-text-secondary">
          Choose a Home to open.
        </p>
        <ul className="flex flex-col gap-3">
          {homes.map((home) => (
            <li key={home.id}>
              <Card padding="md">
                <Link
                  to={`/homes/${home.id}`}
                  className="flex items-center gap-3 font-medium text-text-primary underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
                >
                  <HomeAvatar
                    homeId={home.id}
                    name={home.name}
                    hasPhoto={home.hasPhoto}
                    size="sm"
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span>{home.name}</span>
                    <span className="text-sm font-normal text-text-secondary">
                      {homeRoleLabel(home.role)}
                    </span>
                  </span>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </DocumentTitle>
  );
}

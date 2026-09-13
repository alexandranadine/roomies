import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Card, EmptyState, Spinner } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { homeRoleLabel } from './home-role-label.js';
import { listCurrentUserHomes } from './homes-api.js';

export function HomeDiscoveryPage() {
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
      <DocumentTitle title="Your Homes · Roomies">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Your Homes
          </h1>
          <EmptyState
            title="You’re not currently in a Home"
            description="Create a Home to start coordinating with your roommates."
          />
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
                  className="flex flex-col gap-1 font-medium text-text-primary underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
                >
                  <span>{home.name}</span>
                  <span className="text-sm font-normal text-text-secondary">
                    {homeRoleLabel(home.role)}
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

import { Link, useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Skeleton } from '../components/ui/index.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { ApiError } from '../platform/api/index.js';
import { formatMaintenanceTimestamp } from './maintenance-format.js';
import { MaintenanceStatusBadge } from './maintenance-status-badge.js';
import { PrivateIndicator } from './private-indicator.js';
import { useMaintenanceDetail } from './use-maintenance-detail.js';

function isUnavailableError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function MaintenanceUnavailableState({ homeId }: { homeId: string }) {
  return (
    <DocumentTitle title="Maintenance unavailable · Roomies">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Maintenance item unavailable
        </h1>
        <p className="max-w-prose text-base text-text-secondary">
          It may no longer be available.
        </p>
        <p>
          <Link
            to={`/homes/${encodeURIComponent(homeId)}/maintenance`}
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Maintenance
          </Link>
        </p>
      </div>
    </DocumentTitle>
  );
}

export function MaintenanceDetailPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '', maintenanceEntryId = '' } = useParams();

  const homeId = home.id === routeHomeId ? home.id : '';

  const detailQuery = useMaintenanceDetail({
    homeId,
    maintenanceEntryId,
    enabled: homeId.length > 0 && maintenanceEntryId.length > 0,
  });

  // Only render detail when it belongs to the current route keys.
  const entry =
    detailQuery.data !== undefined &&
    detailQuery.data.id === maintenanceEntryId &&
    homeId === routeHomeId
      ? detailQuery.data
      : undefined;

  if (detailQuery.isError && isUnavailableError(detailQuery.error)) {
    return <MaintenanceUnavailableState homeId={routeHomeId || home.id} />;
  }

  if (detailQuery.isError) {
    return (
      <DocumentTitle title={`Maintenance · ${home.name} · Roomies`}>
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Maintenance
          </h1>
          <Alert variant="danger" title="Couldn’t load this item">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void detailQuery.refetch();
              }}
            >
              Retry
            </Button>
          </Alert>
          <p>
            <Link
              to={`/homes/${encodeURIComponent(home.id)}/maintenance`}
              className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
            >
              Back to Maintenance
            </Link>
          </p>
        </div>
      </DocumentTitle>
    );
  }

  if (entry === undefined) {
    return (
      <DocumentTitle title={`Maintenance · ${home.name} · Roomies`}>
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-8 w-2/3 max-w-md" announced />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DocumentTitle>
    );
  }

  return (
    <DocumentTitle title={`${entry.title} · Maintenance · Roomies`}>
      <article className="flex flex-col gap-5">
        <p>
          <Link
            to={`/homes/${encodeURIComponent(homeId)}/maintenance`}
            className="text-sm font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Maintenance
          </Link>
        </p>

        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <MaintenanceStatusBadge status={entry.status} />
            {entry.visibility === 'PRIVATE' ? <PrivateIndicator /> : null}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight break-words text-text-primary">
            {entry.title}
          </h1>
        </header>

        {entry.details !== null ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-3">
            <h2 className="sr-only">Details</h2>
            <p className="whitespace-pre-wrap break-words text-base text-text-primary">
              {entry.details}
            </p>
          </div>
        ) : null}

        <dl className="flex flex-col gap-2 text-sm text-text-muted">
          <div className="flex flex-wrap gap-x-2">
            <dt>Created</dt>
            <dd>{formatMaintenanceTimestamp(entry.createdAt)}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Updated</dt>
            <dd>{formatMaintenanceTimestamp(entry.updatedAt)}</dd>
          </div>
          {entry.status === 'RESOLVED' && entry.resolvedAt !== null ? (
            <div className="flex flex-wrap gap-x-2">
              <dt>Resolved at</dt>
              <dd>{formatMaintenanceTimestamp(entry.resolvedAt)}</dd>
            </div>
          ) : null}
        </dl>
      </article>
    </DocumentTitle>
  );
}

import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Skeleton } from '../components/ui/index.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { ApiError } from '../platform/api/index.js';
import { formatMaintenanceTimestamp } from './maintenance-format.js';
import { MaintenanceEventIcon } from './maintenance-event-icon.js';
import { MaintenanceStatusBadge } from './maintenance-status-badge.js';
import { PrivateIndicator } from './private-indicator.js';
import { useMaintenanceDetail } from './use-maintenance-detail.js';
import { useResolveMaintenance } from './use-resolve-maintenance.js';

function isUnavailableError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function isAlreadyResolvedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === 'MAINTENANCE_NOT_OPEN'
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
  const [resolveMessage, setResolveMessage] = useState<string | null>(null);
  const [forcedUnavailable, setForcedUnavailable] = useState(false);

  const homeId = home.id === routeHomeId ? home.id : '';

  useEffect(() => {
    setResolveMessage(null);
    setForcedUnavailable(false);
  }, [homeId, maintenanceEntryId]);

  const detailQuery = useMaintenanceDetail({
    homeId,
    maintenanceEntryId,
    enabled:
      !forcedUnavailable && homeId.length > 0 && maintenanceEntryId.length > 0,
  });

  const resolveMutation = useResolveMaintenance();

  // Only render detail when it belongs to the current route keys.
  const entry =
    !forcedUnavailable &&
    detailQuery.data !== undefined &&
    detailQuery.data.id === maintenanceEntryId &&
    homeId === routeHomeId
      ? detailQuery.data
      : undefined;

  if (
    forcedUnavailable ||
    (detailQuery.isError && isUnavailableError(detailQuery.error))
  ) {
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

  const resolvePending = resolveMutation.isPending;

  const onResolve = async () => {
    setResolveMessage(null);
    resolveMutation.reset();
    try {
      await resolveMutation.mutateAsync({
        homeId,
        maintenanceEntryId: entry.id,
      });
      setResolveMessage(null);
    } catch (error) {
      if (isUnavailableError(error)) {
        setForcedUnavailable(true);
        return;
      }
      if (isAlreadyResolvedError(error)) {
        setResolveMessage('This item has already been resolved.');
        void detailQuery.refetch();
        return;
      }
      setResolveMessage('Couldn’t resolve this item. Try again.');
    }
  };

  return (
    <DocumentTitle title={`${entry.title} · Maintenance · Roomies`}>
      <article
        data-testid="maintenance-detail"
        className="mx-auto flex w-full max-w-[980px] flex-col gap-5"
      >
        <p>
          <Link
            to={`/homes/${encodeURIComponent(homeId)}/maintenance`}
            className="text-sm font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Maintenance
          </Link>
        </p>

        <header className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <MaintenanceEventIcon status={entry.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <MaintenanceStatusBadge status={entry.status} />
                {entry.visibility === 'PRIVATE' ? <PrivateIndicator /> : null}
              </div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words text-text-primary">
                {entry.title}
              </h1>
            </div>
          </div>
        </header>

        {entry.details !== null ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
            <h2 className="sr-only">Details</h2>
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary sm:text-base">
              {entry.details}
            </p>
          </div>
        ) : null}

        <dl className="flex flex-col gap-1.5 text-sm text-text-muted">
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

        {entry.status === 'OPEN' ? (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              loading={resolvePending}
              disabled={resolvePending}
              aria-label="Mark resolved"
              onClick={() => {
                void onResolve();
              }}
            >
              Mark resolved
            </Button>
            {resolveMessage !== null ? (
              <Alert
                variant={
                  resolveMessage.includes('already been resolved')
                    ? 'info'
                    : 'danger'
                }
              >
                {resolveMessage}
              </Alert>
            ) : null}
          </div>
        ) : null}
      </article>
    </DocumentTitle>
  );
}

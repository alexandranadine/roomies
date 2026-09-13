import { Link } from 'react-router';
import type { MaintenanceListItem } from './maintenance-api.js';
import { formatMaintenanceTimestamp } from './maintenance-format.js';
import { MaintenanceStatusBadge } from './maintenance-status-badge.js';
import { PrivateIndicator } from './private-indicator.js';

export type MaintenanceListItemRowProps = {
  homeId: string;
  item: MaintenanceListItem;
};

/**
 * Single list row as a link. Not a nested button+link.
 */
export function MaintenanceListItemRow({
  homeId,
  item,
}: MaintenanceListItemRowProps) {
  const metaLabel =
    item.status === 'RESOLVED' && item.resolvedAt !== null
      ? `Resolved ${formatMaintenanceTimestamp(item.resolvedAt)}`
      : `Updated ${formatMaintenanceTimestamp(item.updatedAt)}`;

  return (
    <li>
      <Link
        to={`/homes/${encodeURIComponent(homeId)}/maintenance/${encodeURIComponent(item.id)}`}
        className="flex min-h-control-lg flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3 outline-none transition-colors hover:border-border-strong hover:bg-subtle/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex flex-wrap items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-base font-medium text-text-primary">
            {item.title}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <MaintenanceStatusBadge status={item.status} />
            {item.visibility === 'PRIVATE' ? <PrivateIndicator /> : null}
          </div>
        </div>
        <p className="text-sm text-text-muted">{metaLabel}</p>
      </Link>
    </li>
  );
}

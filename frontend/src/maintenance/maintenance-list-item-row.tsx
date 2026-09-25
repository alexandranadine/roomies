import { Link } from 'react-router';
import { cn } from '../components/ui/cn.js';
import type { MaintenanceListItem } from './maintenance-api.js';
import { MaintenanceEventIcon } from './maintenance-event-icon.js';
import { formatMaintenanceTimestamp } from './maintenance-format.js';
import { MaintenanceStatusBadge } from './maintenance-status-badge.js';
import { PrivateIndicator } from './private-indicator.js';

export type MaintenanceListItemRowProps = {
  homeId: string;
  item: MaintenanceListItem;
};

/**
 * Single list row as a link. Not a nested button+link.
 * Membership IDs stay in React state — never rendered.
 */
export function MaintenanceListItemRow({
  homeId,
  item,
}: MaintenanceListItemRowProps) {
  const resolved = item.status === 'RESOLVED';
  const metaLabel =
    resolved && item.resolvedAt !== null
      ? `Resolved ${formatMaintenanceTimestamp(item.resolvedAt)}`
      : `Updated ${formatMaintenanceTimestamp(item.updatedAt)}`;

  return (
    <li>
      <Link
        to={`/homes/${encodeURIComponent(homeId)}/maintenance/${encodeURIComponent(item.id)}`}
        className={cn(
          'flex min-h-control-lg items-start gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 outline-none lg:gap-3 lg:px-4',
          'transition-colors hover:bg-subtle/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          resolved ? 'bg-success-soft/30 shadow-none' : 'shadow-card',
        )}
      >
        <MaintenanceEventIcon status={item.status} />
        <div className="min-w-0 flex-1">
          <p className="min-w-0 break-words text-sm font-semibold text-text-primary">
            {item.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
            <MaintenanceStatusBadge status={item.status} />
            {item.visibility === 'PRIVATE' ? <PrivateIndicator /> : null}
            <span>{metaLabel}</span>
          </p>
        </div>
      </Link>
    </li>
  );
}

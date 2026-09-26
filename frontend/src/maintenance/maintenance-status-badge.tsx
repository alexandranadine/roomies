import { CheckCircleIcon, ClockIcon } from '@heroicons/react/16/solid';
import { cn } from '../components/ui/cn.js';
import type { MaintenanceStatus } from './maintenance-api.js';
import { formatMaintenanceStatus } from './maintenance-format.js';

/**
 * Compact status label. Color is never the only cue — the word is required.
 */
export function MaintenanceStatusBadge({
  status,
  className,
}: {
  status: MaintenanceStatus;
  className?: string;
}) {
  const resolved = status === 'RESOLVED';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        resolved ? 'text-success' : 'text-brand',
        className,
      )}
    >
      {resolved ? (
        <CheckCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      {formatMaintenanceStatus(status)}
    </span>
  );
}

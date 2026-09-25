import { CircleCheck, Wrench } from 'lucide-react';
import { cn } from '../components/ui/cn.js';
import type { MaintenanceStatus } from './maintenance-api.js';

/**
 * Decorative status glyph in the Home activity bubble language.
 * Meaning lives in the title, status text, and Private label.
 */
export function MaintenanceEventIcon({
  status,
}: {
  status: MaintenanceStatus;
}) {
  const resolved = status === 'RESOLVED';
  const Icon = resolved ? CircleCheck : Wrench;
  return (
    <span
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full lg:size-10',
        resolved
          ? 'bg-success-soft text-success'
          : 'bg-accent-coral-soft text-accent-coral-text',
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
}

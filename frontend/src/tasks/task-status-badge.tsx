import {
  ArrowPathIcon,
  CalendarDaysIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/16/solid';
import { cn } from '../components/ui/cn.js';
import type { TaskDueKind } from './task-format.js';

export function TaskDueMeta({
  kind,
  label,
}: {
  kind: TaskDueKind;
  label: string;
}) {
  const Icon = kind === 'overdue' ? ExclamationCircleIcon : CalendarDaysIcon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        kind === 'overdue' && 'font-medium text-accent-coral-text',
        kind === 'today' && 'text-accent-gold-text',
        kind === 'upcoming' && 'text-text-secondary',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

export function TaskRepeatsMeta() {
  return (
    <span className="inline-flex items-center gap-1 text-text-secondary">
      <ArrowPathIcon className="size-3.5 shrink-0" aria-hidden="true" />
      Repeats
    </span>
  );
}

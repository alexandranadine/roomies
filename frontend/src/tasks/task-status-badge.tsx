import { Badge } from '../components/ui/index.js';
import type { Task } from './tasks-api.js';
import { formatTaskStatus } from './task-format.js';

export function TaskStatusBadge({ status }: { status: Task['status'] }) {
  return (
    <Badge variant={status === 'COMPLETED' ? 'success' : 'neutral'}>
      {formatTaskStatus(status)}
    </Badge>
  );
}

export function TaskRepeatsBadge() {
  return <Badge variant="info">Repeats</Badge>;
}

export function TaskDueBadge({
  kind,
  label,
}: {
  kind: 'overdue' | 'today' | 'upcoming';
  label: string;
}) {
  const variant = kind === 'overdue' ? 'warning' : kind === 'today' ? 'brand' : 'neutral';
  return <Badge variant={variant}>{label}</Badge>;
}

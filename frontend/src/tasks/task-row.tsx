import { Check, CircleCheck } from 'lucide-react';
import { cn } from '../components/ui/cn.js';
import { IconButton } from '../components/ui/index.js';
import type { AssigneeLookup } from './task-assignee.js';
import { assigneeDisplayName } from './task-assignee.js';
import { formatTaskDueLabel, taskDueKind } from './task-format.js';
import { TaskDueMeta, TaskRepeatsMeta } from './task-status-badge.js';
import type { Task } from './tasks-api.js';

export type TaskRowProps = {
  task: Task;
  today: string;
  assigneeLookup: AssigneeLookup;
  completing: boolean;
  completeDisabled: boolean;
  completeError: string | null;
  onComplete: (taskId: string) => void;
};

export function TaskRow({
  task,
  today,
  assigneeLookup,
  completing,
  completeDisabled,
  completeError,
  onComplete,
}: TaskRowProps) {
  const isOpen = task.status === 'OPEN';
  const assignee = assigneeDisplayName(
    task.assignedMembershipId,
    assigneeLookup,
  );
  const dueLabel =
    task.scheduledFor === null
      ? null
      : formatTaskDueLabel(task.scheduledFor, today);
  const dueKind =
    task.scheduledFor === null ? null : taskDueKind(task.scheduledFor, today);
  const isOverdue = isOpen && dueKind === 'overdue';

  return (
    <li
      className={cn(
        'rounded-xl border bg-surface px-3 py-2.5 shadow-card',
        'transition-colors hover:bg-subtle/40',
        isOverdue ? 'border-accent-coral/40' : 'border-border',
        !isOpen && 'border-border bg-success-soft/35 shadow-none',
      )}
    >
      <div className="flex items-start gap-2.5">
        {isOpen ? (
          <IconButton
            type="button"
            variant="secondary"
            loading={completing}
            disabled={completeDisabled}
            aria-label={`Mark ${task.title} done`}
            className={cn(
              'group mt-0.5 size-11 shrink-0 rounded-full border-border-strong text-brand',
              'hover:border-brand hover:bg-brand-soft',
              'active:bg-brand-soft',
            )}
            onClick={() => {
              onComplete(task.id);
            }}
          >
            <Check
              className="size-5 opacity-25 group-hover:opacity-100 group-focus-visible:opacity-100"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          </IconButton>
        ) : (
          <span
            className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
            aria-hidden="true"
          >
            <CircleCheck className="size-5" strokeWidth={2.25} />
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            className={cn(
              'min-w-0 break-words text-sm font-bold leading-snug',
              isOpen ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            {isOpen ? null : <span className="sr-only">Done. </span>}
            {task.title}
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary">
            <span>{assignee}</span>
            {isOpen && dueLabel !== null && dueKind !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <TaskDueMeta kind={dueKind} label={dueLabel} />
              </>
            ) : null}
            {isOpen && task.source === 'RECURRING' ? (
              <>
                <span aria-hidden="true">·</span>
                <TaskRepeatsMeta />
              </>
            ) : null}
          </p>
          {isOpen && completeError ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {completeError}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

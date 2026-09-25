import { Button } from '../components/ui/index.js';
import type { AssigneeLookup } from './task-assignee.js';
import { assigneeDisplayName } from './task-assignee.js';
import {
  formatTaskDueLabel,
  taskDueKind,
} from './task-format.js';
import { TaskDueBadge, TaskRepeatsBadge, TaskStatusBadge } from './task-status-badge.js';
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
  const assignee = assigneeDisplayName(task.assignedMembershipId, assigneeLookup);
  const dueLabel =
    task.scheduledFor === null
      ? null
      : formatTaskDueLabel(task.scheduledFor, today);
  const dueKind =
    task.scheduledFor === null ? null : taskDueKind(task.scheduledFor, today);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-base font-medium text-text-primary">
          {task.title}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <TaskStatusBadge status={task.status} />
          {task.source === 'RECURRING' ? <TaskRepeatsBadge /> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
        <span>{assignee}</span>
        {dueLabel !== null && dueKind !== null ? (
          <TaskDueBadge kind={dueKind} label={dueLabel} />
        ) : null}
      </div>

      {isOpen ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="secondary"
              loading={completing}
              disabled={completeDisabled}
              aria-label={`Mark ${task.title} done`}
              onClick={() => {
                onComplete(task.id);
              }}
            >
              Mark done
            </Button>
          </div>
          {completeError ? (
            <p className="text-sm font-medium text-danger" role="alert">
              {completeError}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

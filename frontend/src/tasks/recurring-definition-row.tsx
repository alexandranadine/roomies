import { useState } from 'react';
import { Button } from '../components/ui/index.js';
import { DeactivateTaskDefinitionDialog } from './deactivate-task-definition-dialog.js';
import type { AssigneeLookup } from './task-assignee.js';
import { assigneeDisplayName } from './task-assignee.js';
import { formatDefinitionNext, formatRecurrence } from './task-format.js';
import { TaskRepeatsBadge } from './task-status-badge.js';
import type { TaskDefinition } from './tasks-api.js';

export type RecurringDefinitionRowProps = {
  homeId: string;
  definition: TaskDefinition;
  assigneeLookup: AssigneeLookup;
  canDeactivate: boolean;
};

export function RecurringDefinitionRow({
  homeId,
  definition,
  assigneeLookup,
  canDeactivate,
}: RecurringDefinitionRowProps) {
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const assignee = assigneeDisplayName(
    definition.assignedMembershipId,
    assigneeLookup,
  );
  const recurrence = formatRecurrence(
    definition.frequency,
    definition.weekday,
    definition.dayOfMonth,
  );
  const nextLabel = formatDefinitionNext(definition);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-base font-medium text-text-primary">
          {definition.title}
        </span>
        <TaskRepeatsBadge />
      </div>
      <p className="text-sm text-text-secondary">
        {recurrence}
        {nextLabel !== null ? ` · ${nextLabel}` : ''}
      </p>
      <p className="text-sm text-text-muted">{assignee}</p>
      {canDeactivate ? (
        <div>
          <Button
            type="button"
            variant="subtle"
            onClick={() => {
              setDeactivateOpen(true);
            }}
          >
            Stop repeating
          </Button>
        </div>
      ) : null}
      <DeactivateTaskDefinitionDialog
        homeId={homeId}
        taskDefinitionId={definition.id}
        title={definition.title}
        open={deactivateOpen}
        onOpenChange={setDeactivateOpen}
      />
    </li>
  );
}

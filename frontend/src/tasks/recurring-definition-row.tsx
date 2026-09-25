import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { IconButton, Menu } from '../components/ui/index.js';
import { DeactivateTaskDefinitionDialog } from './deactivate-task-definition-dialog.js';
import type { AssigneeLookup } from './task-assignee.js';
import { assigneeDisplayName } from './task-assignee.js';
import { formatRecurrence } from './task-format.js';
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

  return (
    <li className="rounded-xl border border-border bg-surface px-3 py-2.5 shadow-card transition-colors hover:bg-subtle/40">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="min-w-0 break-words text-sm font-bold leading-snug text-text-primary">
            {definition.title}
          </p>
          <p className="min-w-0 break-words text-xs text-text-secondary">
            {recurrence}
            <span aria-hidden="true"> · </span>
            {assignee}
          </p>
        </div>
        {canDeactivate ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <IconButton
                  variant="subtle"
                  aria-label={`Actions for ${definition.title}`}
                  className="shrink-0"
                >
                  <MoreHorizontal className="size-5" aria-hidden="true" />
                </IconButton>
              }
            />
            <Menu.Popup>
              <Menu.Item
                aria-label={`Stop repeating ${definition.title}`}
                onClick={() => {
                  setDeactivateOpen(true);
                }}
              >
                Stop repeating
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : null}
      </div>
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

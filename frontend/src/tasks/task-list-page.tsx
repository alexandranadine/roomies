import { PlusIcon } from '@heroicons/react/24/outline';
import { useEffect, useState, type ReactNode } from 'react';
import { useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, Skeleton } from '../components/ui/index.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { useHomeMemberships } from '../homes/use-home-memberships.js';
import { ApiError } from '../platform/api/index.js';
import { useCurrentHomeRole } from '../roommates/use-current-home-role.js';
import { CreateTaskDialog } from './create-task-dialog.js';
import { RecurringDefinitionRow } from './recurring-definition-row.js';
import type { AssigneeLookup } from './task-assignee.js';
import { homeLocalToday, isActiveTaskDefinition } from './task-format.js';
import { TaskRow } from './task-row.js';
import type { Task } from './tasks-api.js';
import { useCompleteTask } from './use-complete-task.js';
import { useHomeTaskDefinitions } from './use-home-task-definitions.js';
import { useHomeTasks } from './use-home-tasks.js';

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function isTransientListError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function isAlreadyCompletedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === 'TASK_ALREADY_COMPLETED'
  );
}

function partitionTasks(tasks: readonly Task[]) {
  const open: Task[] = [];
  const completed: Task[] = [];
  for (const task of tasks) {
    if (task.status === 'COMPLETED') {
      completed.push(task);
      continue;
    }
    open.push(task);
  }
  return { open, completed };
}

function completeErrorMessage(error: unknown): string {
  if (isAlreadyCompletedError(error)) {
    return 'This task is already done.';
  }
  if (isConcealedScope(error)) {
    return 'This Home isn’t available right now.';
  }
  return 'Couldn’t mark this done. Try again.';
}

function SectionHeading({
  id,
  label,
  count,
}: {
  id: string;
  label: string;
  count: number;
}) {
  return (
    <h2
      id={id}
      className="text-base font-semibold tracking-tight text-text-primary"
    >
      {label}{' '}
      <span className="font-medium text-text-muted">{count}</span>
    </h2>
  );
}

function SectionEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border-strong bg-subtle/50 px-4 py-4">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-text-secondary">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

export function TaskListPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [completeErrors, setCompleteErrors] = useState<Record<string, string>>(
    {},
  );

  const homeId = home.id === routeHomeId ? home.id : '';

  useEffect(() => {
    setCreateOpen(false);
    setCompleteErrors({});
  }, [homeId]);

  const tasksQuery = useHomeTasks({
    homeId,
    enabled: homeId.length > 0,
  });
  const definitionsQuery = useHomeTaskDefinitions({
    homeId,
    enabled: homeId.length > 0,
  });
  const membershipsQuery = useHomeMemberships({
    homeId,
    enabled: homeId.length > 0,
  });
  const { isAdmin } = useCurrentHomeRole(homeId);
  const completeMutation = useCompleteTask();

  if (tasksQuery.isError && isConcealedScope(tasksQuery.error)) {
    return (
      <DocumentTitle title="Home unavailable · Roomies">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            This Home isn’t available
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            It may not exist, or you may not be able to open it right now.
          </p>
        </div>
      </DocumentTitle>
    );
  }

  const tasks = tasksQuery.data ?? [];
  const { open, completed } = partitionTasks(tasks);
  const activeDefinitions = (definitionsQuery.data ?? []).filter(
    isActiveTaskDefinition,
  );
  const currentMembershipId = membershipsQuery.data?.currentMembershipId ?? '';
  const assigneeLookup: AssigneeLookup = {
    currentMembershipId,
    memberships: membershipsQuery.data?.memberships ?? [],
    membershipsReady: membershipsQuery.isSuccess,
  };
  const today = homeLocalToday(home.timezone);
  const completingTaskId = completeMutation.isPending
    ? (completeMutation.variables?.taskId ?? null)
    : null;

  const showLoading = tasksQuery.isPending && tasksQuery.data === undefined;
  const showTaskSections = tasksQuery.isSuccess;
  const showDefinitionSection = definitionsQuery.isSuccess;

  function openCreate() {
    setCreateOpen(true);
  }

  async function handleComplete(taskId: string) {
    if (completeMutation.isPending) {
      return;
    }
    setCompleteErrors((current) => {
      if (!(taskId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await completeMutation.mutateAsync({ homeId, taskId });
    } catch (error) {
      setCompleteErrors((current) => ({
        ...current,
        [taskId]: completeErrorMessage(error),
      }));
    }
  }

  return (
    <DocumentTitle title={`Tasks · ${home.name} · Roomies`}>
      <div
        data-testid="tasks-page"
        className="mx-auto flex w-full max-w-[980px] flex-col gap-5"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Tasks
            </h1>
            <p className="text-sm text-text-secondary">
              Keep the house moving.
            </p>
            {showTaskSections && tasks.length > 0 ? (
              <p className="text-xs font-medium text-text-muted">
                {open.length} open · {completed.length} completed
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            className="shrink-0 self-start"
            icon={<PlusIcon className="size-4" aria-hidden="true" />}
            onClick={openCreate}
          >
            Add task
          </Button>
        </header>

        <CreateTaskDialog
          homeId={homeId}
          timeZone={home.timezone}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />

        {showLoading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-16 w-full rounded-xl" announced />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : null}

        {tasksQuery.isError && isTransientListError(tasksQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load tasks">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void tasksQuery.refetch();
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : null}

        {showTaskSections ? (
          <section className="flex flex-col gap-2" aria-labelledby="tasks-open">
            <SectionHeading id="tasks-open" label="Open" count={open.length} />
            {open.length === 0 ? (
              <SectionEmpty
                title="Nothing on the list."
                action={
                  <Button type="button" onClick={openCreate}>
                    Add task
                  </Button>
                }
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2">
                {open.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    today={today}
                    assigneeLookup={assigneeLookup}
                    completing={completingTaskId === task.id}
                    completeDisabled={completeMutation.isPending}
                    completeError={completeErrors[task.id] ?? null}
                    onComplete={(taskId) => {
                      void handleComplete(taskId);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {showTaskSections ? (
          <section
            className="flex flex-col gap-2"
            aria-labelledby="tasks-completed"
          >
            <SectionHeading
              id="tasks-completed"
              label="Completed"
              count={completed.length}
            />
            {completed.length === 0 ? (
              <SectionEmpty title="Completed tasks will show up here." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2">
                {completed.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    today={today}
                    assigneeLookup={assigneeLookup}
                    completing={false}
                    completeDisabled
                    completeError={null}
                    onComplete={() => undefined}
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {definitionsQuery.isError &&
        isTransientListError(definitionsQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load repeating chores">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void definitionsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : null}

        {showDefinitionSection ? (
          <section
            className="flex flex-col gap-2"
            aria-labelledby="tasks-repeating"
          >
            <SectionHeading
              id="tasks-repeating"
              label="Repeating tasks"
              count={activeDefinitions.length}
            />
            {activeDefinitions.length === 0 ? (
              <SectionEmpty
                title="No repeating tasks yet."
                description="Set a chore to repeat so the house doesn’t have to remember."
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2">
                {activeDefinitions.map((definition) => (
                  <RecurringDefinitionRow
                    key={definition.id}
                    homeId={homeId}
                    definition={definition}
                    assigneeLookup={assigneeLookup}
                    canDeactivate={
                      isAdmin ||
                      (currentMembershipId.length > 0 &&
                        currentMembershipId === definition.creatorMembershipId)
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </DocumentTitle>
  );
}

import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
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
  const due: Task[] = [];
  const noDue: Task[] = [];
  const completed: Task[] = [];
  for (const task of tasks) {
    if (task.status === 'COMPLETED') {
      completed.push(task);
      continue;
    }
    if (task.scheduledFor === null) {
      noDue.push(task);
      continue;
    }
    due.push(task);
  }
  return { due, noDue, completed };
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
  const { due, noDue, completed } = partitionTasks(tasks);
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
  const showEmpty =
    tasksQuery.isSuccess &&
    tasks.length === 0 &&
    definitionsQuery.isSuccess &&
    activeDefinitions.length === 0 &&
    !tasksQuery.isFetching;

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
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Tasks
            </h1>
            <p className="max-w-prose text-sm text-text-secondary">
              Household chores the house is working through together.
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-auto">
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              Add task
            </Button>
          </div>
        </header>

        <CreateTaskDialog
          homeId={homeId}
          timeZone={home.timezone}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />

        {showLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-20 w-full" announced />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
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

        {showEmpty ? (
          <EmptyState
            title="No tasks yet"
            description="Add something the house needs to get done."
            action={
              <Button
                type="button"
                onClick={() => {
                  setCreateOpen(true);
                }}
              >
                Add task
              </Button>
            }
          />
        ) : null}

        {due.length > 0 ? (
          <section className="flex flex-col gap-3" aria-labelledby="tasks-due">
            <h2
              id="tasks-due"
              className="text-sm font-semibold text-text-primary"
            >
              Due / upcoming
            </h2>
            <ul className="flex list-none flex-col gap-3 p-0">
              {due.map((task) => (
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
          </section>
        ) : null}

        {noDue.length > 0 ? (
          <section
            className="flex flex-col gap-3"
            aria-labelledby="tasks-no-due"
          >
            <h2
              id="tasks-no-due"
              className="text-sm font-semibold text-text-primary"
            >
              No due date
            </h2>
            <ul className="flex list-none flex-col gap-3 p-0">
              {noDue.map((task) => (
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

        {activeDefinitions.length > 0 ? (
          <section
            className="flex flex-col gap-3"
            aria-labelledby="tasks-repeating"
          >
            <h2
              id="tasks-repeating"
              className="text-sm font-semibold text-text-primary"
            >
              Repeating
            </h2>
            <ul className="flex list-none flex-col gap-3 p-0">
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
          </section>
        ) : null}

        {completed.length > 0 ? (
          <section
            className="flex flex-col gap-3"
            aria-labelledby="tasks-done"
          >
            <h2
              id="tasks-done"
              className="text-sm font-semibold text-text-primary"
            >
              Done
            </h2>
            <ul className="flex list-none flex-col gap-3 p-0">
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
          </section>
        ) : null}
      </div>
    </DocumentTitle>
  );
}

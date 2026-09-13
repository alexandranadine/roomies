import { Router } from 'express';
import { z } from 'zod';
import type { CompleteTaskInput } from '../../application/tasks/complete-task.js';
import type { CreateManualTaskInput } from '../../application/tasks/create-manual-task.js';
import type { CreateRecurringTaskDefinitionInput } from '../../application/tasks/create-recurring-task-definition.js';
import type { DeactivateTaskDefinitionInput } from '../../application/tasks/deactivate-task-definition.js';
import type { ListHomeTaskDefinitionsInput } from '../../application/tasks/list-home-task-definitions.js';
import type { ListHomeTasksInput } from '../../application/tasks/list-home-tasks.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  type ActiveHomeActorResolver,
} from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid, pathUuidSchema } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';
import {
  InvalidHomeLocalDateError,
  InvalidRecurrenceConfigurationError,
  InvalidTaskTitleError,
} from './errors.js';
import { parseHomeLocalDate } from './home-local-date.js';
import { normalizeRecurrenceConfiguration } from './recurrence-config.js';
import { TASK_RECURRENCE_FREQUENCIES } from './recurrence-cursor.js';
import type { TaskDefinition } from './task-definition.js';
import {
  toTaskDefinitionDto,
  toTaskDefinitionListDto,
} from './task-definition-dto.js';
import type { TaskInstance } from './task.js';
import { toTaskDto, toTaskListDto } from './task-dto.js';
import { normalizeTaskTitle } from './task-title.js';

const createTaskBodySchema = z
  .object({
    title: z.string(),
    assignedMembershipId: pathUuidSchema.nullable().optional(),
    scheduledFor: z.string().nullable().optional(),
  })
  .strict();

const completeTaskBodySchema = z.object({}).strict();

const createTaskDefinitionBodySchema = z
  .object({
    title: z.string(),
    frequency: z.enum(TASK_RECURRENCE_FREQUENCIES),
    weekday: z.number().int().nullable().optional(),
    dayOfMonth: z.number().int().nullable().optional(),
    assignedMembershipId: pathUuidSchema.nullable().optional(),
  })
  .strict();

const deactivateTaskDefinitionBodySchema = z.object({}).strict();

export type CreateManualTaskCommand = (
  input: CreateManualTaskInput,
) => Promise<TaskInstance>;

export type ListHomeTasksCommand = (
  input: ListHomeTasksInput,
) => Promise<readonly TaskInstance[]>;

export type CompleteTaskCommand = (
  input: CompleteTaskInput,
) => Promise<TaskInstance>;

export type CreateRecurringTaskDefinitionCommand = (
  input: CreateRecurringTaskDefinitionInput,
) => Promise<TaskDefinition>;

export type ListHomeTaskDefinitionsCommand = (
  input: ListHomeTaskDefinitionsInput,
) => Promise<readonly TaskDefinition[]>;

export type DeactivateTaskDefinitionCommand = (
  input: DeactivateTaskDefinitionInput,
) => Promise<TaskDefinition>;

export type CreateTasksRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createManualTask: CreateManualTaskCommand;
  listHomeTasks: ListHomeTasksCommand;
  completeTask: CompleteTaskCommand;
  createRecurringTaskDefinition: CreateRecurringTaskDefinitionCommand;
  listHomeTaskDefinitions: ListHomeTaskDefinitionsCommand;
  deactivateTaskDefinition: DeactivateTaskDefinitionCommand;
};

function parseCompleteTaskBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  const parsed = completeTaskBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
}

function parseDeactivateTaskDefinitionBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  const parsed = deactivateTaskDefinitionBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
}

function parseCreateTaskDefinitionBody(body: unknown): {
  title: string;
  frequency: (typeof TASK_RECURRENCE_FREQUENCIES)[number];
  weekday: number | null;
  dayOfMonth: number | null;
  assignedMembershipId: string | null;
} {
  const parsed = createTaskDefinitionBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }

  try {
    const recurrence = normalizeRecurrenceConfiguration({
      frequency: parsed.data.frequency,
      weekday: parsed.data.weekday,
      dayOfMonth: parsed.data.dayOfMonth,
    });
    return {
      title: normalizeTaskTitle(parsed.data.title),
      frequency: recurrence.frequency,
      weekday: recurrence.weekday,
      dayOfMonth: recurrence.dayOfMonth,
      assignedMembershipId: parsed.data.assignedMembershipId ?? null,
    };
  } catch (error) {
    if (
      error instanceof InvalidTaskTitleError ||
      error instanceof InvalidRecurrenceConfigurationError
    ) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function parseCreateTaskBody(body: unknown): {
  title: string;
  assignedMembershipId: string | null;
  scheduledFor: string | null;
} {
  const parsed = createTaskBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }

  try {
    return {
      title: normalizeTaskTitle(parsed.data.title),
      assignedMembershipId: parsed.data.assignedMembershipId ?? null,
      scheduledFor:
        parsed.data.scheduledFor === undefined ||
        parsed.data.scheduledFor === null
          ? null
          : parseHomeLocalDate(parsed.data.scheduledFor),
    };
  } catch (error) {
    if (
      error instanceof InvalidTaskTitleError ||
      error instanceof InvalidHomeLocalDateError
    ) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

/**
 * Authenticated Home Task routes. Mount at `/homes` on the v1 router.
 */
export function createTasksRouter(options: CreateTasksRouterOptions): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.post('/:homeId/tasks', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseCreateTaskBody(req.body);
      const created = await options.createManualTask({
        actor,
        homeId,
        title: body.title,
        assignedMembershipId: body.assignedMembershipId,
        scheduledFor: body.scheduledFor,
      });
      res.status(201).json(toTaskDto(created));
    })().catch(next);
  });

  router.get('/:homeId/tasks', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const tasks = await options.listHomeTasks({ actor, homeId });
      res.status(200).json(toTaskListDto(tasks));
    })().catch(next);
  });

  router.post('/:homeId/tasks/:taskId/complete', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const taskId = parsePathUuid(req.params['taskId']);
      parseCompleteTaskBody(req.body);
      const completed = await options.completeTask({
        actor,
        homeId,
        taskId,
      });
      res.status(200).json(toTaskDto(completed));
    })().catch(next);
  });

  router.post('/:homeId/task-definitions', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseCreateTaskDefinitionBody(req.body);
      const created = await options.createRecurringTaskDefinition({
        actor,
        homeId,
        title: body.title,
        frequency: body.frequency,
        weekday: body.weekday,
        dayOfMonth: body.dayOfMonth,
        assignedMembershipId: body.assignedMembershipId,
      });
      res.status(201).json(toTaskDefinitionDto(created));
    })().catch(next);
  });

  router.get('/:homeId/task-definitions', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const definitions = await options.listHomeTaskDefinitions({
        actor,
        homeId,
      });
      res.status(200).json(toTaskDefinitionListDto(definitions));
    })().catch(next);
  });

  router.post(
    '/:homeId/task-definitions/:taskDefinitionId/deactivate',
    (req, res, next) => {
      void (async () => {
        const actor = getActiveHomeActor(res);
        const homeId = parsePathUuid(req.params['homeId']);
        const taskDefinitionId = parsePathUuid(req.params['taskDefinitionId']);
        parseDeactivateTaskDefinitionBody(req.body);
        const deactivated = await options.deactivateTaskDefinition({
          actor,
          homeId,
          taskDefinitionId,
        });
        res.status(200).json(toTaskDefinitionDto(deactivated));
      })().catch(next);
    },
  );

  return router;
}

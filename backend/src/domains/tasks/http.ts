import { Router } from 'express';
import { z } from 'zod';
import type { CreateManualTaskInput } from '../../application/tasks/create-manual-task.js';
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
import { InvalidHomeLocalDateError, InvalidTaskTitleError } from './errors.js';
import { parseHomeLocalDate } from './home-local-date.js';
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

export type CreateManualTaskCommand = (
  input: CreateManualTaskInput,
) => Promise<TaskInstance>;

export type ListHomeTasksCommand = (
  input: ListHomeTasksInput,
) => Promise<readonly TaskInstance[]>;

export type CreateTasksRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createManualTask: CreateManualTaskCommand;
  listHomeTasks: ListHomeTasksCommand;
};

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

  return router;
}

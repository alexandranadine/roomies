import { Router } from 'express';
import { z } from 'zod';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  type ActiveHomeActorResolver,
} from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../../platform/http/require-auth.js';
import {
  canonicalizeIanaTimeZone,
  InvalidIanaTimeZoneError,
} from '../../platform/time/iana-timezone.js';
import type { ArchiveFinalMemberInput } from './archive-final-member.js';
import { toCreatedHomeDto, type CreatedHomeDto } from './created-home-dto.js';
import { getHome } from './get-home.js';
import type { Home } from './home.js';
import { toHomeDto } from './home-dto.js';
import { InvalidHomeNameError, normalizeHomeName } from './home-name.js';
import type { HomeReader } from './repository/home-repository.js';

const archiveFinalMemberBodySchema = z.object({}).strict();

const createHomeBodySchema = z
  .object({
    name: z.string(),
    timezone: z.string(),
  })
  .strict();

export type ArchiveFinalMemberCommand = (
  input: ArchiveFinalMemberInput,
) => Promise<unknown>;

export type CreateHomeCommandInput = Readonly<{
  userId: string;
  name: string;
  timezone: string;
}>;

export type CreateHomeCommandResult = Readonly<{
  home: Home;
  membership: Readonly<{
    id: string;
    role: 'ADMIN';
  }>;
}>;

export type CreateHomeCommand = (
  input: CreateHomeCommandInput,
) => Promise<CreateHomeCommandResult>;

export type CreateHomesRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  homeReader: Pick<HomeReader, 'findActiveHomeById'>;
  archiveFinalMemberHome: ArchiveFinalMemberCommand;
  createHome?: CreateHomeCommand;
};

function parseArchiveFinalMemberBody(body: unknown): void {
  if (!archiveFinalMemberBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

function parseCreateHomeBody(body: unknown): {
  name: string;
  timezone: string;
} {
  const parsed = createHomeBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  try {
    return {
      name: normalizeHomeName(parsed.data.name),
      timezone: canonicalizeIanaTimeZone(parsed.data.timezone),
    };
  } catch (error) {
    if (
      error instanceof InvalidHomeNameError ||
      error instanceof InvalidIanaTimeZoneError
    ) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

/**
 * Authenticated Home routes. POST / creates a Home and does not require an
 * existing Membership. `/:homeId` routes require Home context.
 */
export function createHomesRouter(options: CreateHomesRouterOptions): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  if (options.createHome !== undefined) {
    const createHome = options.createHome;
    router.post('/', (req, res, next) => {
      void (async () => {
        const { principal } = req as RequestWithPrincipal;
        const body = parseCreateHomeBody(req.body);
        const created = await createHome({
          userId: principal.userId,
          name: body.name,
          timezone: body.timezone,
        });
        const dto: CreatedHomeDto = toCreatedHomeDto(created);
        res.status(201).json(dto);
      })().catch(next);
    });
  }

  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.get('/:homeId', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const home = await getHome({ actor, homeId }, options.homeReader);
      res.status(200).json(toHomeDto(home));
    })().catch(next);
  });

  router.post('/:homeId/archive-final-member', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      parseArchiveFinalMemberBody(req.body);
      await options.archiveFinalMemberHome({ actor, homeId });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

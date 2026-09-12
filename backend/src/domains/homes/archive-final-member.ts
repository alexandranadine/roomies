import type { ActiveHomeActor } from '../../platform/authz/context.js';

export type ArchiveFinalMemberInput = Readonly<{
  homeId: string;
  actor: ActiveHomeActor;
}>;

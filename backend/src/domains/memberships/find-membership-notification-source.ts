import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { MembershipNotificationSourceIntegrityError } from './errors.js';

/**
 * Public Notification-safe projection of one immutable role transition.
 * Current Membership role is deliberately absent.
 */
export type MembershipRoleTransitionNotificationSource = Readonly<{
  transitionId: string;
  homeId: string;
  membershipId: string;
  actorMembershipId: string;
  changedAt: Date;
}>;

export type FindMembershipRoleTransitionNotificationSource = (
  tx: TransactionContext,
  input: Readonly<{
    roleTransitionId: string;
    membershipId: string;
    expectedHomeId: string;
  }>,
) => Promise<MembershipRoleTransitionNotificationSource | null>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MEMBERSHIP_ROLE_TRANSITION_NOTIFICATION_SOURCE_SQL = `
SELECT
  t.id,
  t.home_id,
  t.membership_id,
  t.actor_membership_id,
  t.changed_at
FROM membership_role_transitions t
WHERE t.id = $1::uuid
LIMIT 2
`;

type SourceRow = {
  id: unknown;
  home_id: unknown;
  membership_id: unknown;
  actor_membership_id: unknown;
  changed_at: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function findMembershipRoleTransitionNotificationSource(
  tx: TransactionContext,
  input: Readonly<{
    roleTransitionId: string;
    membershipId: string;
    expectedHomeId: string;
  }>,
): Promise<MembershipRoleTransitionNotificationSource | null> {
  if (
    !isUuid(input.roleTransitionId) ||
    !isUuid(input.membershipId) ||
    !isUuid(input.expectedHomeId)
  ) {
    throw new MembershipNotificationSourceIntegrityError();
  }

  let rows: SourceRow[];
  try {
    rows = (
      await tx.query<SourceRow>(
        FIND_MEMBERSHIP_ROLE_TRANSITION_NOTIFICATION_SOURCE_SQL,
        [input.roleTransitionId],
      )
    ).rows;
  } catch {
    throw new MembershipNotificationSourceIntegrityError();
  }
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isUuid(row.membership_id) ||
    !isUuid(row.actor_membership_id) ||
    !(row.changed_at instanceof Date) ||
    Number.isNaN(row.changed_at.valueOf())
  ) {
    throw new MembershipNotificationSourceIntegrityError();
  }

  if (
    row.id !== input.roleTransitionId ||
    row.home_id !== input.expectedHomeId ||
    row.membership_id !== input.membershipId
  ) {
    throw new MembershipNotificationSourceIntegrityError();
  }

  return Object.freeze({
    transitionId: row.id,
    homeId: row.home_id,
    membershipId: row.membership_id,
    actorMembershipId: row.actor_membership_id,
    changedAt: row.changed_at,
  });
}

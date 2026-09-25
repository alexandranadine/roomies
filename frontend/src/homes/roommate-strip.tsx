import { InitialsAvatar } from '../components/ui/index.js';
import type { ActiveHomeMemberships } from './home-memberships-api.js';
import { cn } from '../components/ui/cn.js';

export type RoommateStripProps = {
  memberships: ActiveHomeMemberships;
};

function givenName(name: string): string {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0];
  return first && first.length > 0 ? first : trimmed;
}

/**
 * Horizontal identity row of active Home members. Names only — no invented
 * status, photos, or roles for other people. Height follows content.
 */
export function RoommateStrip({ memberships }: RoommateStripProps) {
  const { currentMembershipId, memberships: members } = memberships;

  if (members.length === 0) {
    return null;
  }

  return (
    <section aria-label="Roommates" className="min-w-0">
      <ul className="-mx-1 flex list-none items-start gap-3 overflow-x-auto px-1 lg:gap-6">
        {members.map((member) => {
          const isCurrent = member.membershipId === currentMembershipId;
          const caption = isCurrent ? 'You' : givenName(member.name);
          const accessible = isCurrent ? `${member.name} (you)` : member.name;

          return (
            <li
              key={member.membershipId}
              className="flex w-14 shrink-0 flex-col items-center gap-1 lg:w-[4.5rem] lg:gap-1.5"
            >
              <InitialsAvatar
                name={member.name}
                label={accessible}
                size="md"
                className="lg:size-16 lg:text-lg"
              />
              <p
                aria-hidden="true"
                className={cn(
                  'w-full truncate text-center text-xs font-medium lg:text-sm',
                  isCurrent ? 'text-brand' : 'text-text-secondary',
                )}
              >
                {caption}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

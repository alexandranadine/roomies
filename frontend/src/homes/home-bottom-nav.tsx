import { Plus } from 'lucide-react';
import { NavLink } from 'react-router';
import { cn } from '../components/ui/cn.js';
import { HOME_NAV_DESTINATIONS } from './home-nav.js';

export type HomeBottomNavProps = {
  homeId: string;
  onOpenActions: () => void;
};

/**
 * Mobile application bar: Home, Tasks, center +, House, Profile.
 * Hidden from md breakpoint up (desktop nav lives in the header).
 */
export function HomeBottomNav({ homeId, onOpenActions }: HomeBottomNavProps) {
  const leading = HOME_NAV_DESTINATIONS.filter(
    (item) => item.id === 'home' || item.id === 'tasks',
  );
  const trailing = HOME_NAV_DESTINATIONS.filter(
    (item) => item.id === 'house' || item.id === 'profile',
  );

  return (
    <nav
      aria-label="Home"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 shadow-nav backdrop-blur-sm"
    >
      <ul className="mx-auto grid h-[4.25rem] max-w-lg grid-cols-5 items-end px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))]">
        {leading.map((destination) => (
          <li key={destination.id} className="flex justify-center">
            <BottomNavLink destination={destination} homeId={homeId} />
          </li>
        ))}
        <li className="flex justify-center">
          <button
            type="button"
            aria-label="Add to this Home"
            onClick={onOpenActions}
            className={cn(
              'mb-1 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-card',
              'outline-none hover:bg-brand-hover active:bg-brand-active',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            <Plus className="size-7" strokeWidth={2.5} aria-hidden="true" />
          </button>
        </li>
        {trailing.map((destination) => (
          <li key={destination.id} className="flex justify-center">
            <BottomNavLink destination={destination} homeId={homeId} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function BottomNavLink({
  destination,
  homeId,
}: {
  destination: (typeof HOME_NAV_DESTINATIONS)[number];
  homeId: string;
}) {
  const Icon = destination.icon;
  return (
    <NavLink
      to={destination.to(homeId)}
      end={destination.end}
      aria-label={destination.accessibleName}
      className={({ isActive }) =>
        cn(
          'flex min-h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1',
          'text-[11px] font-medium outline-none',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          isActive ? 'text-brand' : 'text-text-muted hover:text-text-primary',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn('size-5', isActive && 'fill-current')}
            aria-hidden="true"
          />
          <span className={cn(isActive && 'font-semibold')}>
            {destination.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

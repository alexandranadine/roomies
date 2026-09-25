import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Menu } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import { HomeAvatar } from './home-avatar.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { listCurrentUserHomes, type ActiveHome } from './homes-api.js';

export type HomeSelectorProps = {
  homeId: string;
  homeName: string;
  hasPhoto: boolean;
};

/**
 * Current-Home disclosure. Switching uses GET /me/homes and URL navigation.
 */
export function HomeSelector({
  homeId,
  homeName,
  hasPhoto,
}: HomeSelectorProps) {
  const navigate = useNavigate();
  const homesQuery = useQuery({
    queryKey: currentUserHomesQueryKey,
    queryFn: ({ signal }) => listCurrentUserHomes(signal),
  });
  const homes: readonly ActiveHome[] = homesQuery.data ?? [];

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex max-w-full min-w-0 items-center gap-2 rounded-lg py-0.5 pr-2 text-left',
          'outline-none hover:bg-subtle',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
        aria-label={`Current Home: ${homeName}. Switch Home`}
      >
        <HomeAvatar
          homeId={homeId}
          name={homeName}
          hasPhoto={hasPhoto}
          size="sm"
          className="rounded-md"
        />
        <span className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold tracking-tight text-text-primary">
            {homeName}
          </h1>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-text-muted"
          aria-hidden="true"
        />
      </Menu.Trigger>
      <Menu.Popup className="max-w-72">
        {homes.map((home) => {
          const current = home.id === homeId;
          return (
            <Menu.Item
              key={home.id}
              aria-current={current ? 'true' : undefined}
              className={cn(current && 'font-semibold')}
              onClick={() => {
                if (!current) {
                  void navigate(`/homes/${encodeURIComponent(home.id)}`);
                }
              }}
            >
              {home.name}
              {current ? <span className="sr-only"> (current)</span> : null}
            </Menu.Item>
          );
        })}
        <Menu.Separator />
        <Menu.Item
          onClick={() => {
            void navigate('/');
          }}
        >
          Your Homes
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}

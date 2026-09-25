import { useQuery } from '@tanstack/react-query';
import { User } from 'lucide-react';
import { NavLink, Outlet, useLocation, useMatches } from 'react-router';
import { isAuthCanvasPath } from '../auth/auth-page-layout.js';
import { PageContainer } from '../components/page-container.js';
import { RoomiesWordmark } from '../components/roomies-wordmark.js';
import { cn } from '../components/ui/cn.js';
import { isHomeScopedPath } from '../homes/home-nav.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { NotificationBellLink } from '../notifications/notification-bell-link.js';
import { getCurrentUser } from '../users/current-user-api.js';

const accountNavClassName = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex size-control-lg items-center justify-center rounded-lg',
    'text-text-muted outline-none transition-colors',
    'hover:bg-subtle hover:text-text-primary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    isActive && 'bg-subtle text-text-primary',
  );

function hasHideAppChromeHandle(
  matches: ReturnType<typeof useMatches>,
): boolean {
  return matches.some((match) => {
    const handle = match.handle;
    return (
      handle !== null &&
      typeof handle === 'object' &&
      'hideAppChrome' in handle &&
      handle.hideAppChrome === true
    );
  });
}

/**
 * Application shell: semantic header/main, Roomies branding, global
 * Notifications, Account on non-Home routes, responsive page container.
 * Authenticated chrome is hidden on public auth/invitation canvases, the
 * not-found canvas, and while signed out so those flows do not look like
 * the in-app shell.
 */
export function AppShell() {
  const location = useLocation();
  const matches = useMatches();
  const homeScoped = isHomeScopedPath(location.pathname);
  const authCanvas = isAuthCanvasPath(location.pathname);
  const catchAll = hasHideAppChromeHandle(matches);
  const meQuery = useQuery({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(signal),
    retry: false,
  });
  const signedIn = meQuery.data !== undefined;
  const hideGlobalHeader =
    homeScoped || authCanvas || catchAll || !signedIn;

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
      {hideGlobalHeader ? null : (
        <header className="bg-bg">
          <PageContainer className="flex h-14 items-center justify-between gap-3 sm:h-16">
            <RoomiesWordmark />
            <nav aria-label="Global" className="flex items-center gap-1">
              <NotificationBellLink />
              <NavLink
                to="/account"
                aria-label="Account"
                className={accountNavClassName}
              >
                <User className="size-5" aria-hidden="true" />
              </NavLink>
            </nav>
          </PageContainer>
        </header>
      )}
      <main
        className={
          homeScoped
            ? 'flex min-h-0 flex-1 flex-col'
            : hideGlobalHeader
              ? 'flex flex-1 flex-col'
              : 'flex-1 py-6 sm:py-8'
        }
      >
        {homeScoped || hideGlobalHeader ? (
          <Outlet />
        ) : (
          <PageContainer>
            <Outlet />
          </PageContainer>
        )}
      </main>
    </div>
  );
}

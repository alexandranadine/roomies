import { User } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { PageContainer } from '../components/page-container.js';
import { RoomiesWordmark } from '../components/roomies-wordmark.js';
import { cn } from '../components/ui/cn.js';
import { isHomeScopedPath } from '../homes/home-nav.js';
import { NotificationBellLink } from '../notifications/notification-bell-link.js';

const accountNavClassName = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex size-control-lg items-center justify-center rounded-lg',
    'text-text-muted outline-none transition-colors',
    'hover:bg-subtle hover:text-text-primary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    isActive && 'bg-subtle text-text-primary',
  );

/**
 * Application shell: semantic header/main, Roomies branding, global
 * Notifications, Account on non-Home routes, responsive page container.
 */
export function AppShell() {
  const location = useLocation();
  const homeScoped = isHomeScopedPath(location.pathname);

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
      {homeScoped ? null : (
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
      <main className={homeScoped ? 'flex min-h-0 flex-1 flex-col' : 'flex-1 py-6 sm:py-8'}>
        {homeScoped ? (
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

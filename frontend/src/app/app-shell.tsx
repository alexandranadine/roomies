import { Bell } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { PageContainer } from '../components/page-container.js';
import { cn } from '../components/ui/cn.js';

/**
 * Application shell: semantic header/main, Roomies branding, global
 * Notifications entry, responsive page container.
 */
export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
      <header className="border-b border-border bg-surface">
        <PageContainer className="flex h-14 items-center justify-between gap-3 sm:h-16">
          <p className="text-lg font-semibold tracking-tight text-text-primary">
            Roomies
          </p>
          <nav aria-label="Global">
            <NavLink
              to="/notifications"
              aria-label="Notifications"
              className={({ isActive }) =>
                cn(
                  'inline-flex size-control-lg items-center justify-center rounded-lg',
                  'text-text-muted outline-none transition-colors',
                  'hover:bg-subtle hover:text-text-primary',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  isActive && 'bg-subtle text-text-primary',
                )
              }
            >
              <Bell className="size-5" aria-hidden="true" />
            </NavLink>
          </nav>
        </PageContainer>
      </header>
      <main className="flex-1 py-6 sm:py-8">
        <PageContainer>
          <Outlet />
        </PageContainer>
      </main>
    </div>
  );
}

import { Outlet } from 'react-router';
import { PageContainer } from '../components/page-container.js';

/**
 * Minimal application shell: semantic header/main, Roomies branding,
 * responsive page container. No product navigation yet.
 */
export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
      <header className="border-b border-border bg-surface">
        <PageContainer className="flex h-14 items-center sm:h-16">
          <p className="text-lg font-semibold tracking-tight text-text-primary">
            Roomies
          </p>
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

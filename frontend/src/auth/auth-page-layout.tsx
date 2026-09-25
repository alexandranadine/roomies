import type { ReactNode } from 'react';
import { DocumentTitle } from '../components/document-title.js';
import { RoomiesWordmark } from '../components/roomies-wordmark.js';
import { cn } from '../components/ui/cn.js';

export type AuthPageLayoutSize = 'auth' | 'invite';

export type AuthPageLayoutProps = {
  title: string;
  children: ReactNode;
  size?: AuthPageLayoutSize;
};

const sizeClasses: Record<AuthPageLayoutSize, string> = {
  auth: 'max-w-[27.5rem]',
  invite: 'max-w-[36rem]',
};

/**
 * Centered auth/onboarding canvas. Used when the authenticated app chrome is
 * hidden so sign-in, verification, and invitation share one composition.
 */
export function AuthPageLayout({
  title,
  children,
  size = 'auth',
}: AuthPageLayoutProps) {
  return (
    <DocumentTitle title={title}>
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 sm:py-10">
        <div
          className={cn(
            'flex w-full -translate-y-6 flex-col sm:-translate-y-8',
            sizeClasses[size],
          )}
        >
          <div className="mb-3 flex justify-center">
            <RoomiesWordmark />
          </div>
          <div
            className={cn(
              'flex flex-col',
              size === 'invite' ? 'gap-3' : undefined,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </DocumentTitle>
  );
}

export function isAuthCanvasPath(pathname: string): boolean {
  return (
    pathname === '/verify-email' || pathname.startsWith('/invitations/')
  );
}

export function AuthIconWell({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

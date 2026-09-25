import type { ReactNode } from 'react';
import { HomeChromeLayout } from './home-chrome-layout.js';
import { usePreferredHomeId } from './use-preferred-home-id.js';

export type CrossHomePageShellProps = {
  children: ReactNode;
};

/**
 * Wraps cross-Home authenticated pages with the standard Home chrome when a
 * current/preferred Home can be resolved from existing session/query state.
 */
export function CrossHomePageShell({ children }: CrossHomePageShellProps) {
  const preferredHomeId = usePreferredHomeId();

  if (preferredHomeId === undefined) {
    return <>{children}</>;
  }

  return (
    <HomeChromeLayout homeId={preferredHomeId}>
      {() => children}
    </HomeChromeLayout>
  );
}

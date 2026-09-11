import type { ReactNode } from 'react';

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Responsive content shell (~1024px max on desktop).
 * Mobile-first padding; avoids horizontal overflow at common phone widths.
 */
export function PageContainer({ children, className }: PageContainerProps) {
  const classes = ['mx-auto w-full max-w-[1024px] px-4 sm:px-6', className]
    .filter(Boolean)
    .join(' ');

  return <div className={classes}>{children}</div>;
}

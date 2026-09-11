import type { ReactNode } from 'react';
import { useEffect } from 'react';

type DocumentTitleProps = {
  title: string;
  children?: ReactNode;
};

/** Sets `document.title` for accessible page naming. */
export function DocumentTitle({ title, children }: DocumentTitleProps) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return children ?? null;
}

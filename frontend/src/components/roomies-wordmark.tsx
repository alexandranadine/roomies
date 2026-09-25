import { Link } from 'react-router';
import { cn } from './ui/cn.js';

export type RoomiesWordmarkProps = {
  className?: string;
  /** When set, the lockup navigates without changing its visual treatment. */
  to?: string;
};

const wordmarkClassName =
  'font-sans text-[1.7rem] font-extrabold leading-none tracking-tight text-brand';

/**
 * Brand lockup for shell chrome. Slightly heavier than body headings.
 */
export function RoomiesWordmark({ className, to }: RoomiesWordmarkProps) {
  if (to !== undefined) {
    return (
      <Link
        to={to}
        className={cn(
          wordmarkClassName,
          'inline-block rounded-sm no-underline hover:text-brand hover:no-underline',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
      >
        Roomies
      </Link>
    );
  }

  return <p className={cn(wordmarkClassName, className)}>Roomies</p>;
}

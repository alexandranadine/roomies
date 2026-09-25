import { cn } from './ui/cn.js';

export type RoomiesWordmarkProps = {
  className?: string;
};

/**
 * Brand lockup for shell chrome. Slightly heavier than body headings.
 */
export function RoomiesWordmark({ className }: RoomiesWordmarkProps) {
  return (
    <p
      className={cn(
        'font-sans text-[1.7rem] font-extrabold leading-none tracking-tight text-brand',
        className,
      )}
    >
      Roomies
    </p>
  );
}

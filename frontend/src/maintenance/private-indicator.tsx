import { LockClosedIcon } from '@heroicons/react/16/solid';
import { cn } from '../components/ui/cn.js';

/**
 * Accessible PRIVATE indicator. Icon alone is not sufficient meaning.
 * Shown only on items the viewer is authorized to see.
 */
export function PrivateIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium text-privacy-text',
        className,
      )}
    >
      <LockClosedIcon
        className="size-3.5 shrink-0 text-privacy-icon"
        aria-hidden="true"
      />
      <span>Private</span>
    </span>
  );
}

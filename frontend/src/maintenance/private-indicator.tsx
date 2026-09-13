import { Lock } from 'lucide-react';
import { Badge } from '../components/ui/index.js';

/**
 * Accessible PRIVATE indicator. Icon alone is not sufficient meaning.
 */
export function PrivateIndicator({ className }: { className?: string }) {
  return (
    <Badge variant="privacy" className={className}>
      <span className="inline-flex items-center gap-1">
        <Lock
          className="size-3.5 shrink-0 text-privacy-icon"
          aria-hidden="true"
        />
        <span>Private</span>
      </span>
    </Badge>
  );
}

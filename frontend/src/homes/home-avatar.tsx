import { HomeIcon } from '@heroicons/react/20/solid';
import { cn } from '../components/ui/cn.js';
import { Skeleton } from '../components/ui/index.js';
import { useBlobObjectUrl } from './use-blob-object-url.js';
import { useHomePhoto } from './use-home-photo.js';

const sizeClasses = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
} as const;

export type HomeAvatarSize = keyof typeof sizeClasses;

export type HomeAvatarProps = {
  homeId: string;
  name: string;
  hasPhoto: boolean;
  size?: HomeAvatarSize;
  className?: string;
};

/**
 * Home identity mark. Renders a fetched photo Blob as a local object URL, or
 * a house-icon fallback. Does not accept R2 URLs or object keys.
 */
export function HomeAvatar({
  homeId,
  name,
  hasPhoto,
  size = 'md',
  className,
}: HomeAvatarProps) {
  const photoQuery = useHomePhoto({ homeId, hasPhoto });
  const blob =
    hasPhoto && photoQuery.data instanceof Blob ? photoQuery.data : null;
  const objectUrl = useBlobObjectUrl(blob);
  const loading =
    hasPhoto && photoQuery.isPending && photoQuery.data === undefined;
  const showPhoto = objectUrl !== null && blob !== null;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden rounded-lg bg-subtle text-text-secondary',
        sizeClasses[size],
        className,
      )}
    >
      {loading ? (
        <Skeleton className="size-full rounded-lg" />
      ) : showPhoto ? (
        <img
          src={objectUrl}
          alt={`${name} photo`}
          className="size-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-full items-center justify-center text-brand"
        >
          <HomeIcon className="size-[62%]" />
        </span>
      )}
    </span>
  );
}

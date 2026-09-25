import { cn } from './cn.js';

const TONE_CLASSES = [
  'bg-brand-soft text-brand-soft-text',
  'bg-accent-coral-soft text-accent-coral-text',
  'bg-accent-gold-soft text-accent-gold-text',
  'bg-subtle text-text-secondary',
] as const;

const sizeClasses = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
} as const;

export type InitialsAvatarSize = keyof typeof sizeClasses;

export type InitialsAvatarProps = {
  name: string;
  label?: string;
  size?: InitialsAvatarSize;
  className?: string;
};

function initialsFromName(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    const graphemes = Array.from(parts[0] ?? '');
    return graphemes.slice(0, 2).join('').toUpperCase() || '?';
  }
  const first = Array.from(parts[0] ?? '')[0];
  const last = Array.from(parts[parts.length - 1] ?? '')[0];
  return `${first ?? ''}${last ?? ''}`.toUpperCase() || '?';
}

function toneIndex(name: string): number {
  let hash = name.length;
  for (const char of name) {
    hash = hash * 31 + char.charCodeAt(0);
  }
  return Math.abs(hash) % TONE_CLASSES.length;
}

/**
 * Circular initials fallback. Use when a photo is not available.
 * Accessible name comes from `label` (defaults to `name`).
 */
export function InitialsAvatar({
  name,
  label,
  size = 'md',
  className,
}: InitialsAvatarProps) {
  const accessible = (label ?? name).trim() || 'Roommate';
  const initials = initialsFromName(name);

  return (
    <span
      role="img"
      aria-label={accessible}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-border/80',
        TONE_CLASSES[toneIndex(name)] ?? TONE_CLASSES[0],
        sizeClasses[size],
        className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
    </span>
  );
}
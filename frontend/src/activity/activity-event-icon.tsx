import {
  ArchiveBoxIcon,
  CheckCircleIcon,
  CheckIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/20/solid';
import { cn } from '../components/ui/cn.js';
import type { ActivityIconName } from './activity-copy.js';

const ICONS = {
  'user-plus': UserPlusIcon,
  'user-minus': UserMinusIcon,
  shield: ShieldCheckIcon,
  check: CheckIcon,
  package: ArchiveBoxIcon,
  wrench: WrenchScrewdriverIcon,
  'check-circle': CheckCircleIcon,
} as const;

const TONE_CLASSES: Record<ActivityIconName, string> = {
  'user-plus': 'bg-brand-soft text-brand',
  'user-minus': 'bg-accent-coral-soft text-accent-coral-text',
  shield: 'bg-accent-gold-soft text-accent-gold-text',
  check: 'bg-brand-soft text-brand',
  package: 'bg-accent-gold-soft text-accent-gold-text',
  wrench: 'bg-accent-coral-soft text-accent-coral-text',
  'check-circle': 'bg-brand-soft text-brand',
};

export type ActivityEventIconProps = {
  name: ActivityIconName;
  framed?: boolean;
};

/**
 * Decorative event glyph. Meaning lives in the accompanying sentence.
 */
export function ActivityEventIcon({
  name,
  framed = false,
}: ActivityEventIconProps) {
  const Icon = ICONS[name];
  if (!framed) {
    return (
      <Icon
        className="mt-0.5 size-5 shrink-0 text-text-muted"
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full lg:size-10',
        TONE_CLASSES[name],
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
}

import {
  Bell,
  Check,
  CircleCheck,
  Package,
  Shield,
  Wrench,
} from 'lucide-react';
import { cn } from '../components/ui/cn.js';
import type { NotificationIconName } from './notification-copy.js';

const ICONS = {
  shield: Shield,
  check: Check,
  package: Package,
  wrench: Wrench,
  'check-circle': CircleCheck,
  bell: Bell,
} as const;

const TONE_CLASSES: Record<NotificationIconName, string> = {
  shield: 'bg-accent-gold-soft text-accent-gold-text',
  check: 'bg-brand-soft text-brand',
  package: 'bg-accent-gold-soft text-accent-gold-text',
  wrench: 'bg-accent-coral-soft text-accent-coral-text',
  'check-circle': 'bg-brand-soft text-brand',
  bell: 'bg-brand-soft text-brand',
};

export type NotificationIconProps = {
  name: NotificationIconName;
};

/**
 * Decorative glyph in the same framed bubble language as Home activity.
 * Meaning lives in the accompanying message.
 */
export function NotificationIcon({ name }: NotificationIconProps) {
  const Icon = ICONS[name];
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

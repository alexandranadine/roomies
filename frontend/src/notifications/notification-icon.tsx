import {
  Bell,
  Check,
  CircleCheck,
  Package,
  Shield,
  Wrench,
} from 'lucide-react';
import type { NotificationIconName } from './notification-copy.js';

const ICONS = {
  shield: Shield,
  check: Check,
  package: Package,
  wrench: Wrench,
  'check-circle': CircleCheck,
  bell: Bell,
} as const;

export type NotificationIconProps = {
  name: NotificationIconName;
};

/** Decorative glyph. Meaning lives in the accompanying message. */
export function NotificationIcon({ name }: NotificationIconProps) {
  const Icon = ICONS[name];
  return (
    <Icon
      className="mt-0.5 size-5 shrink-0 text-text-muted"
      aria-hidden="true"
    />
  );
}

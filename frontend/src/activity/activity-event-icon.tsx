import {
  Check,
  CircleCheck,
  Package,
  Shield,
  UserMinus,
  UserPlus,
  Wrench,
} from 'lucide-react';
import type { ActivityIconName } from './activity-copy.js';

const ICONS = {
  'user-plus': UserPlus,
  'user-minus': UserMinus,
  shield: Shield,
  check: Check,
  package: Package,
  wrench: Wrench,
  'check-circle': CircleCheck,
} as const;

export type ActivityEventIconProps = {
  name: ActivityIconName;
};

/**
 * Decorative event glyph. Meaning lives in the accompanying sentence.
 */
export function ActivityEventIcon({ name }: ActivityEventIconProps) {
  const Icon = ICONS[name];
  return (
    <Icon
      className="mt-0.5 size-5 shrink-0 text-text-muted"
      aria-hidden="true"
    />
  );
}

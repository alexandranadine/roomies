import type { LucideIcon } from 'lucide-react';
import { CheckSquare, Home, User, Users } from 'lucide-react';

export type HomeNavDestinationId = 'home' | 'tasks' | 'house' | 'profile';

export type HomeNavDestination = {
  id: HomeNavDestinationId;
  label: string;
  accessibleName: string;
  icon: LucideIcon;
  end?: boolean;
  to: (homeId: string) => string;
};

export const HOME_NAV_DESTINATIONS: readonly HomeNavDestination[] = [
  {
    id: 'home',
    label: 'Home',
    accessibleName: 'Home',
    icon: Home,
    end: true,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}`,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    accessibleName: 'Tasks',
    icon: CheckSquare,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}/tasks`,
  },
  {
    id: 'house',
    label: 'House',
    accessibleName: 'Roommates',
    icon: Users,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}/roommates`,
  },
  {
    id: 'profile',
    label: 'Profile',
    accessibleName: 'Account',
    icon: User,
    to: () => '/account',
  },
];

export function isHomeScopedPath(pathname: string): boolean {
  return /^\/homes\/[^/]+/.test(pathname);
}

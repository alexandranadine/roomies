import type { ComponentType, SVGProps } from 'react';
import {
  ClipboardDocumentCheckIcon as TasksIconOutline,
  HomeIcon as HomeIconOutline,
  UserGroupIcon as UserGroupIconOutline,
  UserIcon as UserIconOutline,
} from '@heroicons/react/24/outline';
import {
  ClipboardDocumentCheckIcon as TasksIconSolid,
  HomeIcon as HomeIconSolid,
  UserGroupIcon as UserGroupIconSolid,
  UserIcon as UserIconSolid,
} from '@heroicons/react/24/solid';

export type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type HomeNavDestinationId = 'home' | 'tasks' | 'house' | 'profile';

export type HomeNavDestination = {
  id: HomeNavDestinationId;
  label: string;
  accessibleName: string;
  iconOutline: HeroIcon;
  iconSolid: HeroIcon;
  end?: boolean;
  to: (homeId: string) => string;
};

export const HOME_NAV_DESTINATIONS: readonly HomeNavDestination[] = [
  {
    id: 'home',
    label: 'Home',
    accessibleName: 'Home',
    iconOutline: HomeIconOutline,
    iconSolid: HomeIconSolid,
    end: true,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}`,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    accessibleName: 'Tasks',
    iconOutline: TasksIconOutline,
    iconSolid: TasksIconSolid,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}/tasks`,
  },
  {
    id: 'house',
    label: 'House',
    accessibleName: 'Roommates',
    iconOutline: UserGroupIconOutline,
    iconSolid: UserGroupIconSolid,
    to: (homeId) => `/homes/${encodeURIComponent(homeId)}/roommates`,
  },
  {
    id: 'profile',
    label: 'Profile',
    accessibleName: 'Account',
    iconOutline: UserIconOutline,
    iconSolid: UserIconSolid,
    to: () => '/account',
  },
];

export function isHomeScopedPath(pathname: string): boolean {
  return /^\/homes\/[^/]+/.test(pathname);
}

/** Authenticated routes outside `/homes/:homeId` that may reuse Home chrome. */
export function isGlobalAuthenticatedPath(pathname: string): boolean {
  return pathname === '/account' || pathname === '/notifications';
}

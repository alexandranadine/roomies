import { ApiError } from '../platform/api/index.js';

const INVITE_GENERIC = 'Invitation could not be created.';
const ROLE_GENERIC = 'Role could not be changed.';
const REMOVE_GENERIC = 'Roommate could not be removed.';
const LEAVE_GENERIC = 'Home could not be left.';

const LAST_ADMIN =
  'This Home needs at least one Home admin. Make another roommate a Home admin first.';

function isConcealedNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

export function isStaleMembershipError(error: unknown): boolean {
  return isConcealedNotFound(error);
}

export function inviteRoommateErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return INVITE_GENERIC;
  }
  switch (error.code) {
    case 'INVITATION_ALREADY_PENDING':
      return 'An invitation is already pending for this email.';
    case 'ALREADY_HOME_MEMBER':
      return 'That person is already a roommate in this Home.';
    case 'RATE_LIMITED':
      return 'Too many invitations right now. Try again in a moment.';
    case 'INVALID_REQUEST':
      return 'Enter a valid email address.';
    default:
      return INVITE_GENERIC;
  }
}

export function changeRoleErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'LAST_ADMIN_REQUIRED') {
    return LAST_ADMIN;
  }
  return ROLE_GENERIC;
}

export function removeRoommateErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'LAST_ADMIN_REQUIRED') {
    return LAST_ADMIN;
  }
  return REMOVE_GENERIC;
}

export function leaveHomeErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'LAST_ADMIN_REQUIRED') {
    return LAST_ADMIN;
  }
  if (
    error instanceof ApiError &&
    error.code === 'LAST_ROOMMATE_REQUIRES_ARCHIVE'
  ) {
    return 'You’re the last roommate in this Home, so it can’t be left this way.';
  }
  return LEAVE_GENERIC;
}

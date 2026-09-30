export const MAKE_ADMIN_MENU_LABEL = 'Make admin';

export const REMOVE_ADMIN_ACCESS_MENU_LABEL = 'Remove admin access';
export const REMOVE_YOUR_ADMIN_ACCESS_MENU_LABEL = 'Remove your admin access';

export const REMOVE_ADMIN_ACCESS_CONFIRM_LABEL = 'Remove admin access';

export type DemoteAdminDialogCopy = Readonly<{
  title: string;
  description: string;
  confirmLabel: string;
  closeLabel: string;
}>;

export function demoteAdminMenuLabel(isSelf: boolean): string {
  return isSelf
    ? REMOVE_YOUR_ADMIN_ACCESS_MENU_LABEL
    : REMOVE_ADMIN_ACCESS_MENU_LABEL;
}

export function demoteAdminDialogCopy(
  isSelf: boolean,
  roommateName: string,
): DemoteAdminDialogCopy {
  if (isSelf) {
    return Object.freeze({
      title: REMOVE_YOUR_ADMIN_ACCESS_MENU_LABEL,
      description:
        "Remove your admin access? You'll stay in this Home as a roommate.",
      confirmLabel: REMOVE_ADMIN_ACCESS_CONFIRM_LABEL,
      closeLabel: 'Close remove admin access',
    });
  }

  return Object.freeze({
    title: REMOVE_ADMIN_ACCESS_MENU_LABEL,
    description: `Remove admin access from ${roommateName}? They'll stay in this Home as a roommate.`,
    confirmLabel: REMOVE_ADMIN_ACCESS_CONFIRM_LABEL,
    closeLabel: 'Close remove admin access',
  });
}

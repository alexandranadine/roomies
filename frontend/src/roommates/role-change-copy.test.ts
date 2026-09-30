import { describe, expect, it } from 'vitest';
import {
  demoteAdminDialogCopy,
  demoteAdminMenuLabel,
  MAKE_ADMIN_MENU_LABEL,
  REMOVE_ADMIN_ACCESS_CONFIRM_LABEL,
  REMOVE_ADMIN_ACCESS_MENU_LABEL,
  REMOVE_YOUR_ADMIN_ACCESS_MENU_LABEL,
} from './role-change-copy.js';

describe('role change copy', () => {
  it('keeps Make admin unchanged', () => {
    expect(MAKE_ADMIN_MENU_LABEL).toBe('Make admin');
  });

  it('uses distinct demotion menu labels for self and other admins', () => {
    expect(demoteAdminMenuLabel(false)).toBe(REMOVE_ADMIN_ACCESS_MENU_LABEL);
    expect(demoteAdminMenuLabel(true)).toBe(
      REMOVE_YOUR_ADMIN_ACCESS_MENU_LABEL,
    );
  });

  it('explains other-admin demotion keeps the person in the Home', () => {
    expect(demoteAdminDialogCopy(false, 'Spooky')).toEqual({
      title: 'Remove admin access',
      description:
        "Remove admin access from Spooky? They'll stay in this Home as a roommate.",
      confirmLabel: REMOVE_ADMIN_ACCESS_CONFIRM_LABEL,
      closeLabel: 'Close remove admin access',
    });
  });

  it('explains self-demotion keeps the user in the Home', () => {
    expect(demoteAdminDialogCopy(true, 'Alex')).toEqual({
      title: 'Remove your admin access',
      description:
        "Remove your admin access? You'll stay in this Home as a roommate.",
      confirmLabel: REMOVE_ADMIN_ACCESS_CONFIRM_LABEL,
      closeLabel: 'Close remove admin access',
    });
  });
});

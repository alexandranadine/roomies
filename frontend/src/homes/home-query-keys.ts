/** Current authenticated User identity. */
export const currentUserQueryKey = ['me'] as const;

/** Server-authoritative active Homes for the current User. */
export const currentUserHomesQueryKey = ['me', 'homes'] as const;

/** Authorized Home identity for the URL Home. Home ID is required. */
export function homeContextQueryKey(homeId: string) {
  return ['home', homeId, 'context'] as const;
}

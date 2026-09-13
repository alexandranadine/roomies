export const INVITATION_PATH_PATTERN =
  /^\/invitations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

export type InvitationFragmentParse =
  { readonly ok: true; readonly secret: string } | { readonly ok: false };

let capturedSecret: string | null = null;

/**
 * Strict fragment parser for the frozen invite URL:
 * `{origin}/invitations/{id}#secret={rawSecret}`
 *
 * Rejects extra parameters, empty values, and non-base64url secrets.
 */
export function parseInvitationFragment(hash: string): InvitationFragmentParse {
  if (hash.length === 0) {
    return { ok: false };
  }
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('secret=')) {
    return { ok: false };
  }
  const encodedValue = raw.slice('secret='.length);
  if (encodedValue.length === 0 || encodedValue.includes('&')) {
    return { ok: false };
  }
  let value: string;
  try {
    value = decodeURIComponent(encodedValue);
  } catch {
    return { ok: false };
  }
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return { ok: false };
  }
  return { ok: true, secret: value };
}

function shouldStripFragment(
  pathname: string,
  hash: string,
  parsed: InvitationFragmentParse,
): boolean {
  return (
    parsed.ok || (INVITATION_PATH_PATTERN.test(pathname) && hash.length > 0)
  );
}

/**
 * Capture the invitation bearer secret from the URL fragment and immediately
 * replace the current history entry so Back cannot restore it.
 *
 * The secret stays in module memory only. A full reload after removal cannot
 * recover it — that is intentional.
 */
export function captureInvitationFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): { secret: string | null } {
  const parsed = parseInvitationFragment(location.hash);
  if (parsed.ok) {
    capturedSecret = parsed.secret;
  }
  if (shouldStripFragment(location.pathname, location.hash, parsed)) {
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${location.search}`,
    );
  }
  return { secret: capturedSecret };
}

export function getCapturedInvitationSecret(): string | null {
  return capturedSecret;
}

/** Remove the bearer from memory immediately after terminal acceptance. */
export function clearCapturedInvitationSecret(): void {
  capturedSecret = null;
}

/** Test isolation only. Production invitation flow never persists or restores. */
export function resetCapturedInvitationSecretForTests(): void {
  capturedSecret = null;
}

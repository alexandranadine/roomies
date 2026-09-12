import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureInvitationFragment,
  parseInvitationFragment,
  resetCapturedInvitationSecretForTests,
} from './capture-invitation-fragment.js';

const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

afterEach(() => {
  resetCapturedInvitationSecretForTests();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

describe('parseInvitationFragment', () => {
  it('accepts the frozen #secret= form', () => {
    expect(parseInvitationFragment(`#secret=${SECRET}`)).toEqual({
      ok: true,
      secret: SECRET,
    });
  });

  it('rejects malformed fragments', () => {
    const malformed = [
      '',
      '#',
      '#secret=',
      '#Secret=abc',
      `#secret=${SECRET}&extra=1`,
      `#foo=${SECRET}`,
      `#secret=${SECRET} extra`,
      `#secret=${encodeURIComponent('not a secret')}`,
      `#secret=${SECRET}/=`,
    ];
    for (const hash of malformed) {
      expect(parseInvitationFragment(hash)).toEqual({ ok: false });
    }
  });
});

describe('captureInvitationFragment', () => {
  it('captures the secret, strips the fragment with replaceState, and leaves no secret in the URL', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    replaceState.mockClear();

    const captured = captureInvitationFragment();

    expect(captured.secret).toBe(SECRET);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0]?.[2]).toBe(
      `/invitations/${INVITATION_ID}`,
    );
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(SECRET);
    expect(window.location.href).not.toContain('#secret=');
    replaceState.mockRestore();
  });

  it('does not write the secret to storage or query params', () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    captureInvitationFragment();

    expect(localStorage.getItem(SECRET)).toBeNull();
    expect(sessionStorage.getItem(SECRET)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    expect(JSON.stringify(sessionStorage)).not.toContain(SECRET);
    expect(window.location.search).not.toContain(SECRET);
    expect(window.location.search).not.toContain('secret=');
  });

  it('replaces the current history entry so Back does not restore the fragment', () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=${SECRET}`,
    );
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    captureInvitationFragment();

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0]?.[2]).toBe(
      `/invitations/${INVITATION_ID}`,
    );
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(SECRET);
    expect(window.location.href).not.toContain('#secret=');
    pushState.mockRestore();
    replaceState.mockRestore();
  });

  it('strips a malformed invitation fragment without storing it', () => {
    window.history.replaceState(
      null,
      '',
      `/invitations/${INVITATION_ID}#secret=`,
    );
    const captured = captureInvitationFragment();
    expect(captured.secret).toBeNull();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('#secret=');
  });
});

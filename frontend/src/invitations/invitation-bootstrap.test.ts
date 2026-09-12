import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import mainSource from '../main.tsx?raw';
import bootstrapSource from './invitation-bootstrap.ts?raw';

describe('invitation fragment bootstrap order', () => {
  it('captures the fragment before React and font CSS initialize', () => {
    const firstImport = mainSource.match(/^import ['"]([^'"]+)['"]/m)?.[1];
    expect(firstImport).toBe('./invitations/invitation-bootstrap.js');
    expect(
      mainSource.indexOf('./invitations/invitation-bootstrap.js'),
    ).toBeLessThan(mainSource.indexOf('@fontsource/manrope'));
    expect(
      mainSource.indexOf('./invitations/invitation-bootstrap.js'),
    ).toBeLessThan(mainSource.indexOf('./app/app-root.js'));
  });

  it('does not load third-party analytics or error reporting before capture', () => {
    const haystack = `${mainSource}\n${html}\n${bootstrapSource}`;
    expect(haystack).not.toMatch(
      /sentry|analytics|gtag|segment|mixpanel|datadog|fullstory|hotjar|bugsnag/i,
    );
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    expect(bootstrapSource).toContain('captureInvitationFragment()');
  });
});

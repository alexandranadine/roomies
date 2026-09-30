import { describe, expect, it } from 'vitest';
import {
  LANDING_COMING_HEADING,
  LANDING_COMING_ITEMS,
  LANDING_FEATURES,
} from './landing-copy.js';

describe('landing copy', () => {
  it('describes current features as present-tense household tools', () => {
    expect(LANDING_FEATURES.map((feature) => feature.title)).toEqual([
      'Tasks',
      'Roommates & invites',
      'Maintenance',
      'Notifications',
      'Home activity',
    ]);
    expect(LANDING_FEATURES[0]?.body).toMatch(/create tasks, assign them, mark them done/i);
  });

  it('keeps coming-later items named without implying they already exist', () => {
    expect(LANDING_COMING_HEADING).toBe('Coming later');
    expect([...LANDING_COMING_ITEMS]).toEqual([
      'Shared supplies',
      'Calendar & events',
      'Polls',
      'House chat',
      'More profile customization',
    ]);
    for (const item of LANDING_COMING_ITEMS) {
      expect(item.toLowerCase()).not.toMatch(
        /create|assign|complete|invite|keep track|see updates/,
      );
    }
  });
});

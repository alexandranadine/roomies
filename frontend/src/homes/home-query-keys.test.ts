import { describe, expect, it } from 'vitest';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
  homeContextQueryKey,
} from './home-query-keys.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('home query keys', () => {
  it('keeps Home-scoped context keys explicit about homeId', () => {
    expect(currentUserQueryKey).toEqual(['me']);
    expect(currentUserHomesQueryKey).toEqual(['me', 'homes']);
    expect(homeContextQueryKey(HOME_ID)).toEqual(['home', HOME_ID, 'context']);
    expect(homeContextQueryKey(HOME_ID)).not.toEqual(
      homeContextQueryKey(OTHER_HOME_ID),
    );
    expect(homeContextQueryKey(HOME_ID)[1]).toBe(HOME_ID);
  });
});

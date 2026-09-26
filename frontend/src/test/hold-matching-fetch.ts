import type { Mock } from 'vitest';

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') {
    return new URL(input, 'http://localhost');
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

export type HoldMatchingFetchesOptions = {
  /** 1-based matching-call index to start holding. Default 2 (background refetch). */
  fromCall?: number;
};

/**
 * Holds matching fetches from `fromCall` until `releaseHold()` so tests can
 * assert UI during pending initial loads or background refetches.
 */
export function holdMatchingFetches(
  fetchMock: Mock,
  isMatch: (url: URL, method: string) => boolean,
  options: HoldMatchingFetchesOptions = {},
) {
  const fromCall = options.fromCall ?? 2;
  const original = fetchMock.getMockImplementation();
  if (original === undefined) {
    throw new Error('fetch mock has no implementation');
  }

  let matchingCalls = 0;
  let releaseHold: () => void = () => {
    /* assigned when the hold Promise is constructed */
  };
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  fetchMock.mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (isMatch(url, method)) {
        matchingCalls += 1;
        if (matchingCalls >= fromCall) {
          return hold.then(() => original(input, init));
        }
      }
      return original(input, init);
    },
  );

  return {
    get matchingCalls() {
      return matchingCalls;
    },
    releaseHold,
  };
}

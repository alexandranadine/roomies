import { useEffect, useState } from 'react';

const DESKTOP_QUERY = '(min-width: 768px)';
const WIDE_QUERY = '(min-width: 1024px)';

function readMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(query);
    const onChange = () => {
      setMatches(media.matches);
    };
    onChange();
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}

/**
 * True at the md breakpoint used for header nav vs bottom nav.
 * jsdom has no stylesheet matching, so this keeps a single nav in tests.
 */
export function useDesktopLayout(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

/**
 * True at the lg breakpoint used for two-column Home and the unified header.
 */
export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

import { useEffect, useState } from 'react';

/**
 * Convert a Blob to a local object URL and revoke it when the Blob changes
 * or the consumer unmounts. Never used for signed remote URLs.
 */
export function useBlobObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob === null || blob === undefined) {
      setUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [blob]);

  return url;
}

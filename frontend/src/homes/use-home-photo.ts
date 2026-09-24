import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { getHomePhotoBlob } from './home-photo-api.js';
import { homePhotoQueryKey } from './home-query-keys.js';

export type UseHomePhotoOptions = {
  homeId: string;
  hasPhoto: boolean;
};

/**
 * Home-photo Blob for one Home. Disabled when the Home is known to have no
 * photo so `/photo` is not requested.
 */
export function useHomePhoto(options: UseHomePhotoOptions) {
  const { homeId, hasPhoto } = options;

  return useQuery({
    queryKey: homePhotoQueryKey(homeId),
    queryFn: ({ signal }) => getHomePhotoBlob(homeId, signal),
    enabled: hasPhoto && homeId.length > 0,
    retry: shouldRetryQuery,
  });
}

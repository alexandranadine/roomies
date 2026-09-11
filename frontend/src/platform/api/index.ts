import { createApiClient, type ApiClient } from './client.js';
import { getFrontendEnv } from '../env/index.js';

export { ApiError } from './api-error.js';
export {
  createApiClient,
  type ApiClient,
  type ApiRequestOptions,
} from './client.js';

let defaultClient: ApiClient | undefined;

/** Application singleton API client (credentials included). */
export function getApiClient(): ApiClient {
  if (defaultClient === undefined) {
    defaultClient = createApiClient(getFrontendEnv().apiOrigin);
  }
  return defaultClient;
}

/** Test helper — clears the process-local singleton. */
export function resetApiClientForTests(): void {
  defaultClient = undefined;
}

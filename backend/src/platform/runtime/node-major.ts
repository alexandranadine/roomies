import { ConfigError } from '../config/errors.js';
import type { AppEnv } from '../config/types.js';

export const REQUIRED_NODE_MAJOR = 24;

export function nodeMajor(version = process.versions.node): number | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isInteger(major) ? major : undefined;
}

/**
 * Production must not silently run Node 22/25. Patch versions are not pinned.
 */
export function assertProductionNodeMajor(
  appEnv: AppEnv,
  version = process.versions.node,
): void {
  if (appEnv !== 'production') {
    return;
  }
  const major = nodeMajor(version);
  if (major !== REQUIRED_NODE_MAJOR) {
    throw new ConfigError(
      `Node.js major version must be ${REQUIRED_NODE_MAJOR} when APP_ENV=production`,
      [
        `Node.js major version must be ${REQUIRED_NODE_MAJOR} when APP_ENV=production`,
      ],
    );
  }
}

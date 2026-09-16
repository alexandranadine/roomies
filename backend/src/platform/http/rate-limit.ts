import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Clock } from '../time/clock.js';
import { systemClock } from '../time/clock.js';
import { RateLimitedError } from './rate-limit-errors.js';
import type { RequestWithPrincipal } from './require-auth.js';
import {
  getTrustedClientNetworkIdentity,
  isCloudflareIngressMode,
} from './trusted-cloudflare-ingress.js';

export type RateLimitClass = 'credential' | 'sensitive' | 'invitation_token';

export type RateLimitPolicy = Readonly<{
  max: number;
  windowMs: number;
}>;

/**
 * Conservative October launch defaults for a small household app.
 *
 * Credential: several roommates on one NAT can mistype passwords without
 * locking the house out, while still blocking high-volume guessing.
 * Sensitive: account deletion and invitation creation stay usable during
 * setup, but automated hammering is stopped quickly.
 * Invitation token: preview/accept retries stay comfortable; 256-bit secrets
 * remain the primary brute-force control.
 */
export const DEFAULT_RATE_LIMITS: Readonly<
  Record<RateLimitClass, RateLimitPolicy>
> = {
  credential: { max: 20, windowMs: 15 * 60 * 1000 },
  sensitive: { max: 10, windowMs: 15 * 60 * 1000 },
  invitation_token: { max: 30, windowMs: 15 * 60 * 1000 },
};

/** Hard cap on simultaneous in-memory buckets. Excess new keys fail closed. */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

/** Background sweep interval. `unref()` so it does not block shutdown. */
export const DEFAULT_RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;

const CREDENTIAL_AUTH_PATHS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/request-password-reset',
  '/api/auth/forget-password',
  '/api/auth/reset-password',
  '/api/auth/send-verification-email',
  '/api/auth/change-password',
  '/api/auth/change-email',
]);

type Bucket = {
  timestamps: number[];
  windowMs: number;
};

export type RateLimitConsumeResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export type RateLimitRuntime = {
  consume(
    limiterClass: RateLimitClass,
    identity: string,
  ): RateLimitConsumeResult;
  bucketCount(): number;
  sweepExpired(): void;
  stop(): void;
};

export type CreateInMemoryRateLimitRuntimeOptions = {
  clock?: Clock;
  policies?: Partial<Record<RateLimitClass, RateLimitPolicy>>;
  maxKeys?: number;
  sweepIntervalMs?: number;
};

function requestPath(req: Request): string {
  const raw = req.originalUrl ?? req.url ?? '';
  return raw.split('?')[0] ?? '';
}

export function isCredentialAuthRequest(req: Request): boolean {
  if (req.method.toUpperCase() !== 'POST') {
    return false;
  }
  return CREDENTIAL_AUTH_PATHS.has(requestPath(req));
}

/**
 * Network identity for unauthenticated limiter classes.
 *
 * Cloudflare ingress uses the request-local identity stored only after
 * origin-auth succeeds. It never falls back to `req.ip`, XFF, X-Real-IP,
 * Host, Origin, or the socket address.
 *
 * Direct ingress uses Express `req.ip` under the configured hop count.
 * Does not read raw `X-Forwarded-For` and does not use cookies, emails,
 * invitation secrets, or session tokens.
 */
export function clientNetworkIdentity(req: Request): string | undefined {
  if (isCloudflareIngressMode(req)) {
    return getTrustedClientNetworkIdentity(req);
  }
  const ip = req.ip;
  if (typeof ip !== 'string') {
    return undefined;
  }
  const trimmed = ip.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function storageKey(limiterClass: RateLimitClass, identity: string): string {
  return `${limiterClass}:${identity}`;
}

function retryAfterSeconds(
  timestamps: readonly number[],
  windowMs: number,
  now: number,
): number {
  const oldest = timestamps[0];
  if (oldest === undefined) {
    return Math.max(1, Math.ceil(windowMs / 1000));
  }
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

/**
 * In-process sliding-window limiter. Safe for a single backend instance.
 * Restarts reset counts. Does not provide distributed/global guarantees.
 */
export function createInMemoryRateLimitRuntime(
  options: CreateInMemoryRateLimitRuntimeOptions = {},
): RateLimitRuntime {
  const clock = options.clock ?? systemClock;
  const policies: Record<RateLimitClass, RateLimitPolicy> = {
    ...DEFAULT_RATE_LIMITS,
    ...options.policies,
  };
  const maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS;
  const sweepIntervalMs = options.sweepIntervalMs ?? 0;
  const buckets = new Map<string, Bucket>();

  const pruneBucket = (bucket: Bucket, now: number): number[] =>
    bucket.timestamps.filter((timestamp) => timestamp > now - bucket.windowMs);

  const sweepExpired = (): void => {
    const now = clock.now().getTime();
    for (const [key, bucket] of buckets) {
      const timestamps = pruneBucket(bucket, now);
      if (timestamps.length === 0) {
        buckets.delete(key);
      } else {
        bucket.timestamps = timestamps;
      }
    }
  };

  const sweepTimer =
    sweepIntervalMs > 0
      ? setInterval(sweepExpired, sweepIntervalMs)
      : undefined;
  sweepTimer?.unref();

  return {
    consume(limiterClass, identity) {
      const policy = policies[limiterClass];
      const now = clock.now().getTime();
      const key = storageKey(limiterClass, identity);
      const existing = buckets.get(key);
      const timestamps = existing ? pruneBucket(existing, now) : [];

      if (timestamps.length >= policy.max) {
        if (existing) {
          existing.timestamps = timestamps;
        }
        return {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(
            timestamps,
            policy.windowMs,
            now,
          ),
        };
      }

      if (existing === undefined && buckets.size >= maxKeys) {
        sweepExpired();
        if (!buckets.has(key) && buckets.size >= maxKeys) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
          };
        }
      }

      timestamps.push(now);
      buckets.set(key, { timestamps, windowMs: policy.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    },
    bucketCount() {
      return buckets.size;
    },
    sweepExpired,
    stop() {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
    },
  };
}

function rejectWithoutIdentity(windowMs: number, next: NextFunction): void {
  next(new RateLimitedError(Math.max(1, Math.ceil(windowMs / 1000))));
}

export function createClassRateLimitMiddleware(
  runtime: RateLimitRuntime,
  limiterClass: RateLimitClass,
  resolveIdentity: (req: Request) => string | undefined,
): RequestHandler {
  const windowMs = DEFAULT_RATE_LIMITS[limiterClass].windowMs;
  return (req: Request, _res: Response, next: NextFunction) => {
    const identity = resolveIdentity(req);
    if (identity === undefined) {
      rejectWithoutIdentity(windowMs, next);
      return;
    }
    const result = runtime.consume(limiterClass, identity);
    if (!result.allowed) {
      next(new RateLimitedError(result.retryAfterSeconds));
      return;
    }
    next();
  };
}

export function createCredentialAuthRateLimit(
  runtime: RateLimitRuntime,
): RequestHandler {
  const limit = createClassRateLimitMiddleware(
    runtime,
    'credential',
    clientNetworkIdentity,
  );
  return (req, res, next) => {
    if (!isCredentialAuthRequest(req)) {
      next();
      return;
    }
    limit(req, res, next);
  };
}

export function createSensitiveUserRateLimit(
  runtime: RateLimitRuntime,
): RequestHandler {
  return createClassRateLimitMiddleware(runtime, 'sensitive', (req) => {
    const userId = (req as RequestWithPrincipal).principal?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      return undefined;
    }
    return `user:${userId}`;
  });
}

export function createInvitationTokenRateLimit(
  runtime: RateLimitRuntime,
): RequestHandler {
  return createClassRateLimitMiddleware(
    runtime,
    'invitation_token',
    clientNetworkIdentity,
  );
}

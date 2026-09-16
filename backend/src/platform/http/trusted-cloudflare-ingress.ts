import { timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError } from '../authz/errors.js';

/**
 * Dedicated header Cloudflare overwrites. Presence of this header is not
 * proof of Cloudflare provenance; only a constant-time match against the
 * configured origin secret is.
 */
export const CLOUDFLARE_ORIGIN_AUTH_HEADER = 'x-roomies-origin-auth';

/** Cloudflare connecting-client address. Trusted only after origin auth. */
export const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip';

const INGRESS_TRUST_MODE = Symbol('roomies.ingressTrustMode');
const TRUSTED_CLIENT_NETWORK_IDENTITY = Symbol(
  'roomies.trustedClientNetworkIdentity',
);

type IngressTrustMode = 'cloudflare';

type RequestWithIngressTrust = Request & {
  [INGRESS_TRUST_MODE]?: IngressTrustMode;
  [TRUSTED_CLIENT_NETWORK_IDENTITY]?: string;
};

function asIngressRequest(req: Request): RequestWithIngressTrust {
  return req as RequestWithIngressTrust;
}

export function isCloudflareIngressMode(req: Request): boolean {
  return asIngressRequest(req)[INGRESS_TRUST_MODE] === 'cloudflare';
}

/**
 * Validated client address stored after successful origin authentication.
 * Undefined when Cloudflare mode has not established a trusted identity
 * (health/ready exemption, failed auth, or direct ingress).
 */
export function getTrustedClientNetworkIdentity(
  req: Request,
): string | undefined {
  return asIngressRequest(req)[TRUSTED_CLIENT_NETWORK_IDENTITY];
}

function markCloudflareIngressMode(req: Request): void {
  asIngressRequest(req)[INGRESS_TRUST_MODE] = 'cloudflare';
}

function storeTrustedClientNetworkIdentity(
  req: Request,
  identity: string,
): void {
  asIngressRequest(req)[TRUSTED_CLIENT_NETWORK_IDENTITY] = identity;
}

function requestPath(req: Request): string {
  const raw = req.originalUrl ?? req.url ?? '';
  return raw.split('?')[0] ?? '';
}

/**
 * Narrow Railway probe exemption. GET `/health` and GET `/ready` only.
 * Does not store a trusted client identity.
 */
export function isRailwayHealthExemption(req: Request): boolean {
  if (req.method.toUpperCase() !== 'GET') {
    return false;
  }
  const path = requestPath(req);
  return path === '/health' || path === '/ready';
}

function secretsEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function valuesFromRawHeaders(req: Request, lowerName: string): string[] {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw) || raw.length < 2) {
    return [];
  }
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    if (typeof key === 'string' && key.toLowerCase() === lowerName) {
      values.push(raw[index + 1] ?? '');
    }
  }
  return values;
}

function valuesFromHeadersDistinct(req: Request, lowerName: string): string[] {
  const distinct = req.headersDistinct[lowerName];
  if (!Array.isArray(distinct)) {
    return [];
  }
  return distinct.filter((value): value is string => typeof value === 'string');
}

type ExactlyOneHeader =
  | Readonly<{ status: 'one'; value: string }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'duplicate' }>;

/**
 * Require the named header to occur exactly once. Uses `headersDistinct` and
 * `rawHeaders` so comma-joining cannot hide a second occurrence.
 */
export function readExactlyOneHeader(
  req: Request,
  lowerName: string,
): ExactlyOneHeader {
  const fromDistinct = valuesFromHeadersDistinct(req, lowerName);
  const fromRaw = valuesFromRawHeaders(req, lowerName);
  if (
    fromDistinct.length > 0 &&
    fromRaw.length > 0 &&
    fromDistinct.length !== fromRaw.length
  ) {
    return { status: 'duplicate' };
  }
  const values = fromDistinct.length > 0 ? fromDistinct : fromRaw;
  if (values.length === 0) {
    return { status: 'missing' };
  }
  if (values.length > 1) {
    return { status: 'duplicate' };
  }
  const value = values[0];
  if (typeof value !== 'string') {
    return { status: 'missing' };
  }
  return { status: 'one', value };
}

function ipv4ToHextets(ip: string): readonly [string, string] | undefined {
  if (!isIPv4(ip)) {
    return undefined;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value << 8) + octet;
  }
  const unsigned = value >>> 0;
  return [
    ((unsigned >>> 16) & 0xffff).toString(16),
    (unsigned & 0xffff).toString(16),
  ];
}

function expandIpv6Hextets(address: string): string[] | undefined {
  let working = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(working);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) {
    return undefined;
  }
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(working);
  if (dotted?.[1] !== undefined) {
    const hextets = ipv4ToHextets(dotted[1]);
    if (hextets === undefined) {
      return undefined;
    }
    working = `${working.slice(0, dotted.index)}:${hextets[0]}:${hextets[1]}`;
  }
  if (working.includes('.')) {
    return undefined;
  }

  const doubleColon = working.split('::');
  if (doubleColon.length > 2) {
    return undefined;
  }

  let parts: string[];
  if (doubleColon.length === 1) {
    parts = working.split(':');
  } else {
    const head =
      doubleColon[0] === '' ? [] : (doubleColon[0]?.split(':') ?? []);
    const tail =
      doubleColon[1] === '' ? [] : (doubleColon[1]?.split(':') ?? []);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return undefined;
    }
    parts = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }

  if (parts.length !== 8) {
    return undefined;
  }
  const hextets: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 4 || !/^[0-9a-f]+$/u.test(part)) {
      return undefined;
    }
    hextets.push(part.padStart(4, '0'));
  }
  return hextets;
}

function compressIpv6(hextets: readonly string[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let index = 0; index < hextets.length; index += 1) {
    if (hextets[index] === '0000') {
      if (currentStart === -1) {
        currentStart = index;
        currentLength = 1;
      } else {
        currentLength += 1;
      }
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  }

  const stripped = hextets.map((hextet) => hextet.replace(/^0+(?=\w)/u, ''));
  if (bestLength < 2) {
    return stripped.join(':');
  }

  const head = stripped.slice(0, bestStart).join(':');
  const tail = stripped.slice(bestStart + bestLength).join(':');
  if (head.length === 0 && tail.length === 0) {
    return '::';
  }
  if (head.length === 0) {
    return `::${tail}`;
  }
  if (tail.length === 0) {
    return `${head}::`;
  }
  return `${head}::${tail}`;
}

function ipv4MappedFromHextets(hextets: readonly string[]): string | undefined {
  if (hextets.length !== 8) {
    return undefined;
  }
  const prefix = hextets.slice(0, 5);
  if (prefix.some((hextet) => hextet !== '0000') || hextets[5] !== 'ffff') {
    return undefined;
  }
  const high = hextets[6];
  const low = hextets[7];
  if (high === undefined || low === undefined) {
    return undefined;
  }
  const highValue = Number.parseInt(high, 16);
  const lowValue = Number.parseInt(low, 16);
  const ipv4 = `${(highValue >> 8) & 0xff}.${highValue & 0xff}.${(lowValue >> 8) & 0xff}.${lowValue & 0xff}`;
  return isIPv4(ipv4) ? ipv4 : undefined;
}

/**
 * Parse a single IP from `CF-Connecting-IP`. Rejects comma-separated lists,
 * ports, brackets, zone IDs, and CIDR. IPv6 is RFC 5952-compressed and
 * IPv4-mapped addresses become dotted IPv4 so limiter buckets stay stable.
 */
export function parseSingleClientIp(raw: string): string | undefined {
  if (raw.includes(',')) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/[\s/%[\]]/u.test(trimmed)) {
    return undefined;
  }
  if (isIPv4(trimmed)) {
    return trimmed;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) {
    return mapped[1];
  }
  if (!isIPv6(trimmed)) {
    return undefined;
  }
  const hextets = expandIpv6Hextets(trimmed);
  if (hextets === undefined) {
    return undefined;
  }
  return ipv4MappedFromHextets(hextets) ?? compressIpv6(hextets);
}

function rejectClosed(next: NextFunction): void {
  next(new ForbiddenError());
}

/**
 * Cloudflare production ingress trust boundary.
 *
 * Origin authentication (dedicated overwritten secret) runs first. Only then
 * is a single `CF-Connecting-IP` parsed and stored as request-local identity.
 * Host, Origin, XFF, X-Real-IP, and socket.remoteAddress are never treated as
 * Cloudflare provenance. Failures are closed with a generic Forbidden error.
 */
export function createTrustedCloudflareIngressMiddleware(
  originAuthSecret: string,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    markCloudflareIngressMode(req);

    if (isRailwayHealthExemption(req)) {
      next();
      return;
    }

    const originAuth = readExactlyOneHeader(req, CLOUDFLARE_ORIGIN_AUTH_HEADER);
    if (
      originAuth.status !== 'one' ||
      !secretsEqual(originAuthSecret, originAuth.value)
    ) {
      rejectClosed(next);
      return;
    }

    const connectingIp = readExactlyOneHeader(req, CF_CONNECTING_IP_HEADER);
    if (connectingIp.status !== 'one') {
      rejectClosed(next);
      return;
    }
    const identity = parseSingleClientIp(connectingIp.value);
    if (identity === undefined) {
      rejectClosed(next);
      return;
    }

    storeTrustedClientNetworkIdentity(req, identity);
    next();
  };
}

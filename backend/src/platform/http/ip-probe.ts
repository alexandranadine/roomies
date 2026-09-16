import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ConfigError } from '../config/errors.js';
import { clientNetworkIdentity } from './rate-limit.js';
import {
  getTrustedClientNetworkIdentity,
  parseSingleClientIp,
} from './trusted-cloudflare-ingress.js';

/**
 * TEMPORARY_PRODUCTION_IP_PROBE_REMOVE_AFTER_VERIFICATION
 *
 * Diagnostic-only Cloudflare → Railway → Express hop probe.
 * Delete this file, its test, the main.ts mount, and the SECRET_ENV_KEYS
 * entry immediately after the production capture. Restoring
 * production-scripts.test.ts to forbid IP_PROBE / __diag/ip-probe returns
 * the original "no production probe" invariant. Do not keep this route.
 */
export const TEMPORARY_PRODUCTION_IP_PROBE_MARKER =
  'TEMPORARY_PRODUCTION_IP_PROBE_REMOVE_AFTER_VERIFICATION';

export const IP_PROBE_PATH = '/__diag/ip-probe';
export const IP_PROBE_TOKEN_HEADER = 'x-ip-probe-token';

/** Truncated SHA-256 hex length used by the M9.3 staging probe. */
export const IP_PROBE_HASH_LENGTH = 16;

const MIN_TOKEN_LENGTH = 32;
const MIN_TOKEN_ENTROPY_BITS = 120;

export type IpProbeHandlerOptions = Readonly<{
  token: string;
  trustProxyHops: number;
}>;

export type IpProbeDiagnostic = Readonly<{
  trustProxyHops: number;
  xffHopCount: number;
  hopHashes: readonly string[];
  reqIpHash: string | null;
  reqIpsHashes: readonly string[];
  xRealIpHash: string | null;
  cfConnectingIpHash: string | null;
  socketRemoteIsPrivate: boolean;
  canaryInXff: boolean;
  canaryInXRealIp: boolean;
  reqIpMatchesLeftmostXff: boolean;
  reqIpMatchesRightmostXff: boolean;
  reqIpMatchesXRealIp: boolean;
  reqIpMatchesCfConnectingIp: boolean;
  xRealIpMatchesCfConnectingIp: boolean;
  edgeAuthSucceeded: boolean;
  trustedLimiterIdentityHash: string | null;
  trustedIdentityMatchesCfConnectingIp: boolean;
  trustedIdentityMatchesXffIntermediary: boolean;
  canaryInCfConnectingIp: boolean;
}>;

function estimatedSecretEntropy(value: string): number {
  const uniqueCharacters = new Set(value).size;
  return uniqueCharacters === 0
    ? 0
    : value.length * Math.log2(uniqueCharacters);
}

/**
 * Read `IP_PROBE_TOKEN`. Unset/blank means the route must not be mounted.
 * A present but weak value fails closed at boot (no secret echoed).
 */
export function ipProbeTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env['IP_PROBE_TOKEN'];
  if (raw === undefined) {
    return undefined;
  }
  const token = raw.trim();
  if (token.length === 0) {
    return undefined;
  }
  if (
    token.length < MIN_TOKEN_LENGTH ||
    estimatedSecretEntropy(token) < MIN_TOKEN_ENTROPY_BITS
  ) {
    throw new ConfigError(
      'Invalid configuration:\n  - IP_PROBE_TOKEN must be a high-entropy random value',
      ['IP_PROBE_TOKEN must be a high-entropy random value'],
    );
  }
  return token;
}

export function hashNetworkValue(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return createHash('sha256')
    .update(trimmed)
    .digest('hex')
    .slice(0, IP_PROBE_HASH_LENGTH);
}

function probeTokensEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function singleHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return undefined;
  }
  return undefined;
}

function forwardedHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.join(',');
  }
  return undefined;
}

function splitForwardedHops(header: string | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return header
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
}

function stripIpv4Mapped(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const rest = address.slice('::ffff:'.length);
    if (isIPv4(rest)) {
      return rest;
    }
  }
  return address;
}

function ipv4ToInt(ip: string): number | undefined {
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
  return value >>> 0;
}

function inCidr(ipInt: number, prefix: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (prefix & mask);
}

function isTestNetIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) {
    return false;
  }
  return (
    inCidr(n, 0xc0000200, 24) ||
    inCidr(n, 0xc6336400, 24) ||
    inCidr(n, 0xcb007100, 24)
  );
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) {
    return false;
  }
  return (
    inCidr(n, 0x00000000, 8) ||
    inCidr(n, 0x0a000000, 8) ||
    inCidr(n, 0x64400000, 10) ||
    inCidr(n, 0x7f000000, 8) ||
    inCidr(n, 0xa9fe0000, 16) ||
    inCidr(n, 0xac100000, 12) ||
    inCidr(n, 0xc0a80000, 16)
  );
}

function firstIpv6Hextet(address: string): number | undefined {
  const first = address.split(':')[0];
  if (first === undefined || first.length === 0) {
    return 0;
  }
  const hextet = Number.parseInt(first, 16);
  return Number.isFinite(hextet) ? hextet : undefined;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') {
    return true;
  }
  const hextet = firstIpv6Hextet(lower);
  if (hextet === undefined) {
    return false;
  }
  if (hextet >= 0xfe80 && hextet <= 0xfebf) {
    return true;
  }
  if (hextet >= 0xfc00 && hextet <= 0xfdff) {
    return true;
  }
  return false;
}

export function isPrivateOrLocalAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const trimmed = stripIpv4Mapped(address.trim());
  if (trimmed.length === 0) {
    return false;
  }
  if (isIPv4(trimmed)) {
    return isPrivateIpv4(trimmed);
  }
  if (isIPv6(trimmed)) {
    return isPrivateIpv6(trimmed);
  }
  return false;
}

export function hopIsTestNetCanary(hop: string): boolean {
  return isTestNetIpv4(stripIpv4Mapped(hop.trim()));
}

function hashesEqual(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

function buildDiagnostic(
  req: Request,
  trustProxyHops: number,
): IpProbeDiagnostic {
  const xffHops = splitForwardedHops(forwardedHeader(req, 'x-forwarded-for'));
  const hopHashes = xffHops.map((hop) => hashNetworkValue(hop) ?? '');
  const reqIpHash = hashNetworkValue(req.ip);
  const reqIpsHashes = (req.ips ?? []).map(
    (hop) => hashNetworkValue(hop) ?? '',
  );
  const xRealIpHash = hashNetworkValue(forwardedHeader(req, 'x-real-ip'));
  const cfConnectingIpHash = hashNetworkValue(
    forwardedHeader(req, 'cf-connecting-ip'),
  );
  const leftmostXff = hopHashes[0] ?? null;
  const rightmostXff =
    hopHashes.length > 0 ? (hopHashes[hopHashes.length - 1] ?? null) : null;
  const trustedIdentity = getTrustedClientNetworkIdentity(req);
  const selectedIdentity = clientNetworkIdentity(req);
  const trustedLimiterIdentityHash = hashNetworkValue(selectedIdentity);
  const cfConnectingRaw = forwardedHeader(req, 'cf-connecting-ip');
  const cfConnectingHops = splitForwardedHops(cfConnectingRaw);
  const parsedCfIdentity = parseSingleClientIp(cfConnectingRaw ?? '');
  const parsedCfIdentityHash = hashNetworkValue(parsedCfIdentity);

  return {
    trustProxyHops,
    xffHopCount: xffHops.length,
    hopHashes,
    reqIpHash,
    reqIpsHashes,
    xRealIpHash,
    cfConnectingIpHash,
    socketRemoteIsPrivate: isPrivateOrLocalAddress(req.socket.remoteAddress),
    canaryInXff: xffHops.some(hopIsTestNetCanary),
    canaryInXRealIp: hopIsTestNetCanary(
      forwardedHeader(req, 'x-real-ip') ?? '',
    ),
    reqIpMatchesLeftmostXff: hashesEqual(reqIpHash, leftmostXff),
    reqIpMatchesRightmostXff: hashesEqual(reqIpHash, rightmostXff),
    reqIpMatchesXRealIp: hashesEqual(reqIpHash, xRealIpHash),
    reqIpMatchesCfConnectingIp: hashesEqual(reqIpHash, cfConnectingIpHash),
    xRealIpMatchesCfConnectingIp: hashesEqual(xRealIpHash, cfConnectingIpHash),
    edgeAuthSucceeded: trustedIdentity !== undefined,
    trustedLimiterIdentityHash,
    trustedIdentityMatchesCfConnectingIp: hashesEqual(
      trustedLimiterIdentityHash,
      parsedCfIdentityHash ?? cfConnectingIpHash,
    ),
    trustedIdentityMatchesXffIntermediary: hopHashes.some(
      (hopHash) => hopHash.length > 0 && hopHash === trustedLimiterIdentityHash,
    ),
    canaryInCfConnectingIp: cfConnectingHops.some(hopIsTestNetCanary),
  };
}

/**
 * GET-only diagnostic. Wrong/missing token calls `next()` so the response is
 * the ordinary unknown-route 404. Does not log extracted network values.
 */
export function createIpProbeHandler(
  options: IpProbeHandlerOptions,
): RequestHandler {
  const { token, trustProxyHops } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method.toUpperCase() !== 'GET') {
      next();
      return;
    }
    const provided = singleHeader(req, IP_PROBE_TOKEN_HEADER);
    if (provided === undefined || !probeTokensEqual(token, provided)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(buildDiagnostic(req, trustProxyHops));
  };
}

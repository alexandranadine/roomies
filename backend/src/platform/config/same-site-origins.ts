/**
 * Conservative same-site (schemeful) check for production frontend/API hosts.
 * Not a full Public Suffix List. Known provider suffixes are treated as
 * registrable-site boundaries so `*.workers.dev` and `*.railway.app` cannot
 * satisfy the frozen host-only SameSite=Lax cookie model.
 */

const PUBLIC_SUFFIXES = new Set([
  'workers.dev',
  'github.io',
  'pages.dev',
  'railway.app',
  'up.railway.app',
  'fly.dev',
  'herokuapp.com',
  'netlify.app',
  'vercel.app',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudflare.net',
]);

const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'co.jp',
]);

export function registrableSite(hostname: string): string | undefined {
  const labels = hostname.trim().toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) {
    return undefined;
  }
  const host = labels.join('.');
  if (PUBLIC_SUFFIXES.has(host)) {
    return undefined;
  }

  for (let index = 1; index < labels.length; index += 1) {
    const suffix = labels.slice(index).join('.');
    if (PUBLIC_SUFFIXES.has(suffix)) {
      if (index === 0) {
        return undefined;
      }
      return labels.slice(index - 1).join('.');
    }
  }

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    if (labels.length < 3) {
      return undefined;
    }
    return labels.slice(-3).join('.');
  }

  return lastTwo;
}

/**
 * True when both origins share a scheme and registrable site.
 * Used for production SameSite=Lax host-only cookies (no Domain attribute).
 */
export function areSameSiteOrigins(left: string, right: string): boolean {
  let leftUrl: URL;
  let rightUrl: URL;
  try {
    leftUrl = new URL(left);
    rightUrl = new URL(right);
  } catch {
    return false;
  }
  if (leftUrl.protocol !== rightUrl.protocol) {
    return false;
  }
  const leftSite = registrableSite(leftUrl.hostname);
  const rightSite = registrableSite(rightUrl.hostname);
  return (
    leftSite !== undefined && rightSite !== undefined && leftSite === rightSite
  );
}

#!/usr/bin/env node
/**
 * CI sanity: workflows must not require repository secrets or a local .env file.
 * Scans .github/workflows for secret references that would break fork PRs.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(root, '.github', 'workflows');

const DISALLOWED = [
  {
    pattern: /\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/i,
    label: 'repository secret expression',
  },
  {
    pattern: /(?:^|[\s"'`=])\.env(?:\.local)?(?:$|[\s"'`])/i,
    label: 'local .env file reference',
  },
  { pattern: /neon\.tech/i, label: 'neon.tech' },
  { pattern: /cloudflare/i, label: 'cloudflare' },
  { pattern: /railway\.app/i, label: 'railway.app' },
];

const ALLOWED_SECRET_EXCEPTIONS = [
  // GitHub provides these automatically; not repository secrets.
  /secrets\.GITHUB_TOKEN/i,
];

let files;
try {
  files = await readdir(workflowsDir);
} catch (error) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    console.error('No .github/workflows directory found.');
    process.exit(1);
  }
  throw error;
}

/** @type {string[]} */
const problems = [];

for (const name of files) {
  if (!/\.(yml|yaml)$/i.test(name)) continue;
  const full = path.join(workflowsDir, name);
  const text = await readFile(full, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return;

    for (const rule of DISALLOWED) {
      if (!rule.pattern.test(line)) continue;
      if (ALLOWED_SECRET_EXCEPTIONS.some((ex) => ex.test(line))) continue;
      problems.push(
        `${name}:${index + 1}: disallowed ${rule.label}: ${trimmed}`,
      );
    }
  });
}

if (problems.length > 0) {
  console.error('CI workflow secrets policy violations:\n');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log('CI workflows do not require repository secrets or local .env.');

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authRuntime = path.join(root, 'backend', 'auth-runtime');
const npmCli = process.env['npm_execpath'];

if (!npmCli) {
  throw new Error('npm_execpath is required to install auth-runtime');
}

// npm lifecycle processes inherit the root package's local-prefix setting.
// Remove it so the child npm resolves auth-runtime/package.json instead of
// recursively running the root postinstall again.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toLowerCase().startsWith('npm_'),
  ),
);

const result = spawnSync(process.execPath, [npmCli, 'ci'], {
  cwd: authRuntime,
  env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

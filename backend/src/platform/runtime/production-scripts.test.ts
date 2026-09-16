import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const repoRoot = path.resolve(backendRoot, '..');

void describe('deployment production scripts', () => {
  void it('uses compiled JS for production start and does not auto-migrate', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(backendRoot, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
      engines?: { node?: string; npm?: string };
    };

    assert.equal(pkg.scripts?.['start:prod'], 'node dist/main.js');
    assert.equal(pkg.scripts?.['start:prod']?.includes('tsx'), false);
    assert.equal(pkg.scripts?.['start:prod']?.includes('ts-node'), false);
    assert.equal(pkg.scripts?.build, 'node scripts/build-production.mjs');
    assert.equal(pkg.scripts?.['db:migrate'], 'prisma db migrate');
    assert.equal(
      pkg.scripts?.['db:migrate:release'],
      'tsx scripts/migrate-release.ts',
    );
    assert.equal(pkg.scripts?.['db:migrate']?.includes('push'), false);
    assert.equal(pkg.scripts?.['start']?.includes('migrate'), false);
    assert.equal(pkg.scripts?.['start:prod']?.includes('migrate'), false);
    assert.match(pkg.engines?.node ?? '', />=24 <25/);
    assert.match(pkg.engines?.npm ?? '', />=10/);
  });

  void it('keeps the combined process as the default backend role', async () => {
    const source = await readFile(
      path.join(backendRoot, 'src/platform/config/types.ts'),
      'utf8',
    );
    assert.match(source, /DEFAULT_PROCESS_MODE: ProcessMode = 'combined'/);
  });

  void it('does not encode a Railway pre-deploy migrate or replica guess', async () => {
    const rootPkg = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    assert.equal(
      rootPkg.scripts?.['db:migrate:release'],
      'npm run db:migrate:release --workspace=@roomies/backend',
    );
    assert.equal(rootPkg.scripts?.['start:prod']?.includes('migrate'), false);
  });

  void it('probes readiness with the shared pool, not Prisma connect()', async () => {
    const source = await readFile(
      path.join(backendRoot, 'src/main.ts'),
      'utf8',
    );
    assert.match(source, /pool\.query\('SELECT 1'\)/);
    assert.doesNotMatch(source, /STAGING_IP_PROBE/);
    assert.doesNotMatch(source, /staging-ip-probe/);
  });

  void it('fails production when Node major is not 24', async () => {
    const main = await readFile(path.join(backendRoot, 'src/main.ts'), 'utf8');
    const nodeMajor = await readFile(
      path.join(backendRoot, 'src/platform/runtime/node-major.ts'),
      'utf8',
    );
    assert.match(main, /assertProductionNodeMajor\(config\.appEnv\)/);
    assert.match(nodeMajor, /REQUIRED_NODE_MAJOR = 24/);
    assert.doesNotMatch(main, /\/debug\/node/);
  });

  void it('does not expose mail secrets to the Vite public env surface', async () => {
    const source = await readFile(
      path.join(repoRoot, 'frontend/src/vite-env.d.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /EMAIL_API_KEY|AUTH_SECRET|DATABASE_URL/);
    assert.match(source, /VITE_API_ORIGIN/);
  });
});

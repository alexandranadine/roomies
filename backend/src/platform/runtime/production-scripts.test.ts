import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const repoRoot = path.resolve(backendRoot, '..');

async function listTypeScriptSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptSources(full)));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

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
  });

  void it('does not retain a forwarding-header diagnostic', async () => {
    const probeModule = ['ip', '-probe'].join('');
    const removed = [
      ['IP', '_PROBE'].join(''),
      ['__diag', '/', probeModule].join(''),
      probeModule,
      [
        'TEMPORARY_PRODUCTION',
        '_IP',
        '_PROBE',
        '_REMOVE_AFTER_VERIFICATION',
      ].join(''),
      ['IP', '_PROBE', '_TOKEN'].join(''),
      ['STAGING', '_IP', '_PROBE'].join(''),
      ['staging', '-', probeModule].join(''),
      ['x-', probeModule, '-token'].join(''),
    ];
    for (const name of [`${probeModule}.ts`, `${probeModule}.test.ts`]) {
      await assert.rejects(
        access(path.join(backendRoot, 'src/platform/http', name)),
      );
    }
    const files = await listTypeScriptSources(path.join(backendRoot, 'src'));
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = path.relative(backendRoot, file).replaceAll('\\', '/');
      for (const needle of removed) {
        assert.equal(
          source.includes(needle),
          false,
          `${rel} reintroduces a removed diagnostic`,
        );
      }
    }
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const mainPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../main.ts',
);

void describe('combined process shutdown composition', () => {
  void it('closes the limiter, Prisma client, then the shared pool after HTTP/worker stop', async () => {
    const source = await readFile(mainPath, 'utf8');

    const limiterStop = source.indexOf('rateLimits.stop()');
    const poolClose = source.indexOf('await databasePool.close()');
    const httpSignalsOff = source.indexOf('installSignalHandlers: false');
    const startProcessCall = source.indexOf('startProcess({');
    const createHttp = source.indexOf('createHttp:');
    const createWorker = source.indexOf('createWorker:');

    assert.ok(limiterStop > 0, 'limiter stop must be composed');
    assert.ok(
      poolClose > limiterStop,
      'pool close follows limiter stop in source',
    );
    assert.ok(
      httpSignalsOff > 0,
      'HTTP server must not install its own signals',
    );
    assert.ok(startProcessCall > 0);
    assert.ok(createHttp > startProcessCall);
    assert.ok(createWorker > startProcessCall);
    assert.match(source, /mode: config\.processMode/);
    assert.doesNotMatch(source, /db migrate|db push|migration:plan/);
  });
});

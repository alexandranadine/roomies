import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  prismaCliDatabaseUrlMissingMessage,
  resolvePrismaCliDatabaseUrl,
} from './prisma-cli-database-url.js';

void describe('resolvePrismaCliDatabaseUrl', () => {
  void it('prefers MIGRATION_DATABASE_URL when set', () => {
    const url = resolvePrismaCliDatabaseUrl({
      DATABASE_URL: 'postgresql://runtime:secret@db.example:5432/roomies',
      MIGRATION_DATABASE_URL:
        'postgresql://migrator:secret@db.example:5432/roomies',
    });
    assert.equal(url, 'postgresql://migrator:secret@db.example:5432/roomies');
  });

  void it('falls back to DATABASE_URL for local and CI', () => {
    const url = resolvePrismaCliDatabaseUrl({
      DATABASE_URL:
        'postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies',
    });
    assert.equal(
      url,
      'postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies',
    );
  });

  void it('returns undefined when neither URL is present', () => {
    assert.equal(resolvePrismaCliDatabaseUrl({}), undefined);
  });

  void it('does not put secret values in the missing-url message', () => {
    const message = prismaCliDatabaseUrlMissingMessage();
    assert.equal(message.includes('postgresql://'), false);
    assert.equal(message.includes('secret'), false);
    assert.match(message, /DATABASE_URL/);
  });

  void it('documents the Prisma CLI preference in prisma.config.ts', async () => {
    const source = await readFile(
      new URL('../../../prisma.config.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /MIGRATION_DATABASE_URL/);
    assert.match(source, /DATABASE_URL/);
    assert.doesNotMatch(source, /db push/);
  });
});

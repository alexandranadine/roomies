import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBackendRoot } from './load-dotenv.js';

const configDir = dirname(fileURLToPath(import.meta.url));

void describe('findBackendRoot', () => {
  void it('finds @roomies/backend from the config source directory', () => {
    const root = findBackendRoot(configDir);
    assert.equal(root, resolve(configDir, '../../..'));
  });

  void it('finds @roomies/backend from a nested dist-like directory', () => {
    const distLike = resolve(configDir, '../../..', 'dist');
    const root = findBackendRoot(distLike);
    assert.equal(root, resolve(configDir, '../../..'));
  });
});

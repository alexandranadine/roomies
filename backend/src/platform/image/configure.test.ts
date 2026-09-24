import assert from 'node:assert/strict';
import sharp from 'sharp';
import { describe, it } from 'node:test';
import { configureHomePhotoImageProcessor } from './configure.js';

void describe('configureHomePhotoImageProcessor', () => {
  void it('sets concurrency 1 and a bounded cache', () => {
    configureHomePhotoImageProcessor();
    assert.equal(sharp.concurrency(), 1);
    const cache = sharp.cache();
    assert.equal(cache.memory.max, 32);
    assert.equal(cache.files.max, 0);
    assert.equal(cache.items.max, 20);
  });
});

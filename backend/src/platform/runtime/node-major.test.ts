import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../config/errors.js';
import {
  REQUIRED_NODE_MAJOR,
  assertProductionNodeMajor,
  nodeMajor,
} from './node-major.js';

void describe('production Node major assertion', () => {
  void it('accepts Node 24 in production and ignores other environments', () => {
    assert.equal(REQUIRED_NODE_MAJOR, 24);
    assert.equal(nodeMajor('24.11.0'), 24);
    assert.doesNotThrow(() =>
      assertProductionNodeMajor('production', '24.1.0'),
    );
    assert.doesNotThrow(() => assertProductionNodeMajor('staging', '22.0.0'));
    assert.doesNotThrow(() =>
      assertProductionNodeMajor('development', '25.0.0'),
    );
  });

  void it('fails production when the major is not 24', () => {
    assert.throws(
      () => assertProductionNodeMajor('production', '22.14.0'),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /Node.js major version must be 24/);
        assert.equal(error.message.includes('22.14.0'), false);
        return true;
      },
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { AuthorizationIntegrityError } from '../../../platform/authz/errors.js';
import {
  createHomeRepository,
  FIND_ACTIVE_HOME_SQL,
} from './home-repository.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_OBJECT_KEY = `homes/${HOME_ID}/photo/11111111-1111-4111-8111-111111111111.webp`;

function poolWithRows(rows: unknown[]): Pool {
  return {
    query: () => Promise.resolve({ rows }),
  } as unknown as Pool;
}

void describe('FIND_ACTIVE_HOME_SQL', () => {
  void it('selects the canonical photo pointer for an unarchived Home', () => {
    assert.match(FIND_ACTIVE_HOME_SQL, /photo_object_key/);
    assert.match(FIND_ACTIVE_HOME_SQL, /archived_at IS NULL/);
    assert.doesNotMatch(FIND_ACTIVE_HOME_SQL, /FOR UPDATE/i);
  });
});

void describe('createHomeRepository', () => {
  void it('maps a null pointer to photoObjectKey null', async () => {
    const homes = createHomeRepository(
      poolWithRows([
        {
          id: HOME_ID,
          name: 'Oak Street',
          timezone: 'UTC',
          photo_object_key: null,
        },
      ]),
    );
    assert.deepEqual(await homes.findActiveHomeById(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      photoObjectKey: null,
    });
  });

  void it('maps a canonical pointer without coercing it', async () => {
    const homes = createHomeRepository(
      poolWithRows([
        {
          id: HOME_ID,
          name: 'Oak Street',
          timezone: 'UTC',
          photo_object_key: PHOTO_OBJECT_KEY,
        },
      ]),
    );
    assert.deepEqual(await homes.findActiveHomeById(HOME_ID), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      photoObjectKey: PHOTO_OBJECT_KEY,
    });
  });

  void it('fails closed on malformed photo_object_key values', async () => {
    for (const photo_object_key of [
      `tmp/${PHOTO_OBJECT_KEY}`,
      PHOTO_OBJECT_KEY.toUpperCase(),
      `homes/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/photo/11111111-1111-4111-8111-111111111111.webp`,
      1,
    ]) {
      const homes = createHomeRepository(
        poolWithRows([
          {
            id: HOME_ID,
            name: 'Oak Street',
            timezone: 'UTC',
            photo_object_key,
          },
        ]),
      );
      await assert.rejects(
        () => homes.findActiveHomeById(HOME_ID),
        AuthorizationIntegrityError,
      );
    }
  });
});

import type { Pool } from 'pg';
import { AuthorizationIntegrityError } from '../../../platform/authz/errors.js';
import type { Home } from '../home.js';
import { storedHomePhotoObjectKey } from '../photo-object-key.js';

export const FIND_ACTIVE_HOME_SQL = `
SELECT id, name, timezone, photo_object_key
FROM homes
WHERE id = $1
  AND archived_at IS NULL
`;

export type HomeReader = {
  findActiveHomeById(homeId: string): Promise<Home | null>;
};

type HomeRow = {
  id: unknown;
  name: unknown;
  timezone: unknown;
  photo_object_key: unknown;
};

function mapActiveHomeRow(row: HomeRow): Home {
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.timezone !== 'string'
  ) {
    throw new AuthorizationIntegrityError();
  }

  return Object.freeze({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    photoObjectKey: storedHomePhotoObjectKey(row.photo_object_key, row.id),
  });
}

/**
 * Final Home read independently requires archived_at IS NULL. Do not assume
 * earlier ActiveHomeActor resolution still holds for the rest of the request.
 */
export function createHomeRepository(pool: Pool): HomeReader {
  return {
    async findActiveHomeById(homeId) {
      let rows: HomeRow[];
      try {
        const result = await pool.query<HomeRow>(FIND_ACTIVE_HOME_SQL, [
          homeId,
        ]);
        rows = result.rows;
      } catch {
        throw new AuthorizationIntegrityError();
      }

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      if (row === undefined) {
        throw new AuthorizationIntegrityError();
      }

      return mapActiveHomeRow(row);
    },
  };
}

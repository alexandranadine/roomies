import { MaintenanceActivitySourceIntegrityError } from './errors.js';
import {
  isMaintenanceVisibility,
  type MaintenanceVisibility,
} from './maintenance.js';

/**
 * Public Activity-list Maintenance display. HOUSEHOLD may include the
 * list-safe title. PRIVATE title is never selected.
 */
export type MaintenanceActivityDisplay = Readonly<{
  id: string;
  visibility: MaintenanceVisibility;
  title: string | null;
}>;

export type FindMaintenanceActivityDisplaysInput = Readonly<{
  homeId: string;
  maintenanceEntryIds: readonly string[];
}>;

export type MaintenanceActivityDisplayQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type FindMaintenanceActivityDisplays = (
  db: MaintenanceActivityDisplayQueryable,
  input: FindMaintenanceActivityDisplaysInput,
) => Promise<ReadonlyMap<string, MaintenanceActivityDisplay>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_MAINTENANCE_ACTIVITY_DISPLAYS_SQL = `
SELECT
  e.id,
  e.visibility,
  CASE
    WHEN e.visibility = 'HOUSEHOLD' THEN e.title
    ELSE NULL
  END AS title
FROM maintenance_entries e
WHERE e.home_id = $1::uuid
  AND e.id = ANY($2::uuid[])
`;

type DisplayRow = {
  id: unknown;
  visibility: unknown;
  title: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function findMaintenanceActivityDisplays(
  db: MaintenanceActivityDisplayQueryable,
  input: FindMaintenanceActivityDisplaysInput,
): Promise<ReadonlyMap<string, MaintenanceActivityDisplay>> {
  if (!isUuid(input.homeId)) {
    throw new MaintenanceActivitySourceIntegrityError();
  }
  const unique = new Set<string>();
  for (const maintenanceEntryId of input.maintenanceEntryIds) {
    if (!isUuid(maintenanceEntryId)) {
      throw new MaintenanceActivitySourceIntegrityError();
    }
    unique.add(maintenanceEntryId);
  }
  if (unique.size === 0) {
    return new Map();
  }

  let rows: DisplayRow[];
  try {
    const result = await db.query<DisplayRow>(
      FIND_MAINTENANCE_ACTIVITY_DISPLAYS_SQL,
      [input.homeId, [...unique]],
    );
    rows = result.rows;
  } catch (error) {
    if (error instanceof MaintenanceActivitySourceIntegrityError) {
      throw error;
    }
    throw new MaintenanceActivitySourceIntegrityError();
  }

  const displays = new Map<string, MaintenanceActivityDisplay>();
  for (const row of rows) {
    if (
      !isUuid(row.id) ||
      !isMaintenanceVisibility(row.visibility) ||
      displays.has(row.id)
    ) {
      throw new MaintenanceActivitySourceIntegrityError();
    }
    let title: string | null = null;
    if (row.visibility === 'HOUSEHOLD') {
      if (typeof row.title !== 'string' || row.title.length === 0) {
        throw new MaintenanceActivitySourceIntegrityError();
      }
      title = row.title;
    } else if (row.title !== null) {
      throw new MaintenanceActivitySourceIntegrityError();
    }
    displays.set(
      row.id,
      Object.freeze({
        id: row.id,
        visibility: row.visibility,
        title,
      }),
    );
  }
  return displays;
}

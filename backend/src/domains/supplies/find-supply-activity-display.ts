import { SupplyActivitySourceIntegrityError } from './errors.js';

/**
 * Public Activity-list Supply display. Title is HOME_VISIBLE list-safe data.
 * No claimant or user identifiers.
 */
export type SupplyActivityDisplay = Readonly<{
  id: string;
  title: string;
}>;

export type FindSupplyActivityDisplaysInput = Readonly<{
  homeId: string;
  supplyEntryIds: readonly string[];
}>;

export type SupplyActivityDisplayQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type FindSupplyActivityDisplays = (
  db: SupplyActivityDisplayQueryable,
  input: FindSupplyActivityDisplaysInput,
) => Promise<ReadonlyMap<string, SupplyActivityDisplay>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_SUPPLY_ACTIVITY_DISPLAYS_SQL = `
SELECT
  e.id,
  e.title
FROM supply_entries e
WHERE e.home_id = $1::uuid
  AND e.id = ANY($2::uuid[])
`;

type DisplayRow = {
  id: unknown;
  title: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function findSupplyActivityDisplays(
  db: SupplyActivityDisplayQueryable,
  input: FindSupplyActivityDisplaysInput,
): Promise<ReadonlyMap<string, SupplyActivityDisplay>> {
  if (!isUuid(input.homeId)) {
    throw new SupplyActivitySourceIntegrityError();
  }
  const unique = new Set<string>();
  for (const supplyEntryId of input.supplyEntryIds) {
    if (!isUuid(supplyEntryId)) {
      throw new SupplyActivitySourceIntegrityError();
    }
    unique.add(supplyEntryId);
  }
  if (unique.size === 0) {
    return new Map();
  }

  let rows: DisplayRow[];
  try {
    const result = await db.query<DisplayRow>(
      FIND_SUPPLY_ACTIVITY_DISPLAYS_SQL,
      [input.homeId, [...unique]],
    );
    rows = result.rows;
  } catch (error) {
    if (error instanceof SupplyActivitySourceIntegrityError) {
      throw error;
    }
    throw new SupplyActivitySourceIntegrityError();
  }

  const displays = new Map<string, SupplyActivityDisplay>();
  for (const row of rows) {
    if (
      !isUuid(row.id) ||
      typeof row.title !== 'string' ||
      row.title.length === 0 ||
      displays.has(row.id)
    ) {
      throw new SupplyActivitySourceIntegrityError();
    }
    displays.set(
      row.id,
      Object.freeze({
        id: row.id,
        title: row.title,
      }),
    );
  }
  return displays;
}

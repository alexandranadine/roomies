import { TaskActivitySourceIntegrityError } from './errors.js';

/**
 * Public Activity-list Task display. Title is HOME_VISIBLE list-safe data.
 * No assignee or user identifiers.
 */
export type TaskActivityDisplay = Readonly<{
  id: string;
  title: string;
}>;

export type FindTaskActivityDisplaysInput = Readonly<{
  homeId: string;
  taskInstanceIds: readonly string[];
}>;

export type TaskActivityDisplayQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type FindTaskActivityDisplays = (
  db: TaskActivityDisplayQueryable,
  input: FindTaskActivityDisplaysInput,
) => Promise<ReadonlyMap<string, TaskActivityDisplay>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIND_TASK_ACTIVITY_DISPLAYS_SQL = `
SELECT
  t.id,
  t.title
FROM task_instances t
WHERE t.home_id = $1::uuid
  AND t.id = ANY($2::uuid[])
`;

type DisplayRow = {
  id: unknown;
  title: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function findTaskActivityDisplays(
  db: TaskActivityDisplayQueryable,
  input: FindTaskActivityDisplaysInput,
): Promise<ReadonlyMap<string, TaskActivityDisplay>> {
  if (!isUuid(input.homeId)) {
    throw new TaskActivitySourceIntegrityError();
  }
  const unique = new Set<string>();
  for (const taskInstanceId of input.taskInstanceIds) {
    if (!isUuid(taskInstanceId)) {
      throw new TaskActivitySourceIntegrityError();
    }
    unique.add(taskInstanceId);
  }
  if (unique.size === 0) {
    return new Map();
  }

  let rows: DisplayRow[];
  try {
    const result = await db.query<DisplayRow>(FIND_TASK_ACTIVITY_DISPLAYS_SQL, [
      input.homeId,
      [...unique],
    ]);
    rows = result.rows;
  } catch (error) {
    if (error instanceof TaskActivitySourceIntegrityError) {
      throw error;
    }
    throw new TaskActivitySourceIntegrityError();
  }

  const displays = new Map<string, TaskActivityDisplay>();
  for (const row of rows) {
    if (
      !isUuid(row.id) ||
      typeof row.title !== 'string' ||
      row.title.length === 0 ||
      displays.has(row.id)
    ) {
      throw new TaskActivitySourceIntegrityError();
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

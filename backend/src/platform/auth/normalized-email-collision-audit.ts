export type EmailCollisionQuery = Readonly<{
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

type CollisionRow = {
  ids: unknown;
};

export class NormalizedEmailCollisionError extends Error {
  readonly collisionIds: readonly (readonly string[])[];

  constructor(collisionIds: readonly (readonly string[])[]) {
    super(
      `Normalized email collision audit failed for ${String(collisionIds.length)} group(s)`,
    );
    this.name = 'NormalizedEmailCollisionError';
    this.collisionIds = Object.freeze(
      collisionIds.map((ids) => Object.freeze([...ids])),
    );
  }
}

export async function assertNoNormalizedEmailCollisions(
  database: EmailCollisionQuery,
): Promise<void> {
  const result = await database.query<CollisionRow>(`
    SELECT array_agg(id::text ORDER BY id) AS ids
    FROM auth_identities
    GROUP BY lower(btrim(email))
    HAVING COUNT(*) > 1
    ORDER BY min(id::text)
  `);

  const collisionIds = result.rows.map((row) => {
    if (
      !Array.isArray(row.ids) ||
      row.ids.length < 2 ||
      row.ids.some((id) => typeof id !== 'string')
    ) {
      throw new Error('Normalized email collision audit returned invalid data');
    }
    return row.ids as string[];
  });

  if (collisionIds.length > 0) {
    throw new NormalizedEmailCollisionError(collisionIds);
  }
}

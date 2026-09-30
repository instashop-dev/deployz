/**
 * Cold-start shortcut: whether drizzle's migrator has nothing left to apply.
 *
 * The migrator applies a journal entry only when its `when` timestamp is newer
 * than the `created_at` of the last row in `drizzle.__drizzle_migrations`. So
 * when that last row is at least as new as the newest journal entry, running
 * the migrator is a no-op, and one cheap query replaces re-reading every
 * bundled migration on every cold start.
 *
 * Fail-safe: any error (missing table on a fresh database, connection hiccup)
 * answers "not up to date", and the caller runs the migrator exactly as before.
 */
export interface MigrationQueryable {
  query(text: string): Promise<{ rows: { created_at: string | number | null }[] }>;
}

export async function migrationsUpToDate(
  db: MigrationQueryable,
  journal: { entries: readonly { when: number }[] },
): Promise<boolean> {
  if (journal.entries.length === 0) return false;
  try {
    const newestBundled = Math.max(...journal.entries.map((entry) => entry.when));
    const result = await db.query(
      'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
    );
    const applied = result.rows[0]?.created_at;
    if (applied === undefined || applied === null) return false;
    return Number(applied) >= newestBundled;
  } catch {
    return false;
  }
}

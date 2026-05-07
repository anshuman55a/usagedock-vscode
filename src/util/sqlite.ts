import Database from 'better-sqlite3';

/**
 * Read a single value from a VSCode-style state.vscdb SQLite database.
 * Opens read-only to avoid write-locking the file.
 */
export function readDbValue(dbPath: string, key: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch (err) {
    console.error(`UsageDock: readDbValue failed for key="${key}" in ${dbPath}:`, err);
    return null;
  } finally {
    db?.close();
  }
}

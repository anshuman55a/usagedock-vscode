import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database } from 'sql.js';

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

/**
 * Lazily initialize sql.js (WASM-based SQLite — no native bindings needed).
 * Works in any Node/Electron runtime regardless of ABI version.
 */
function getSql(): ReturnType<typeof initSqlJs> {
  if (!sqlPromise) {
    // Locate the WASM binary relative to this module.
    // In the installed VSIX the file lives at:
    //   <ext-dir>/node_modules/sql.js/dist/sql-wasm.wasm
    // __dirname resolves to <ext-dir>/dist when running inside the bundle.
    const wasmBinary = fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    );
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}

/**
 * Read a single value from a VSCode-style state.vscdb SQLite database.
 * Opens an in-memory copy to avoid write-locking the file.
 */
export async function readDbValue(dbPath: string, key: string): Promise<string | null> {
  let db: Database | null = null;
  try {
    const SQL = await getSql();
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    const result = db.exec('SELECT value FROM ItemTable WHERE key = ? LIMIT 1', [key]);
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    const value = result[0].values[0][0];
    return typeof value === 'string' ? value : value != null ? String(value) : null;
  } catch (err) {
    console.error(`UsageDock: readDbValue failed for key="${key}" in ${dbPath}:`, err);
    return null;
  } finally {
    db?.close();
  }
}

import { Database } from "bun:sqlite";

/**
 * Open an existing SQLite database without write access.
 *
 * Bun accepts a filesystem pathname here. SQLite `file:` URI handling differs
 * between Bun platforms, so the explicit readonly option is the portable mode
 * switch and the path must not be converted to a URI.
 */
export function openReadonlyDatabase(path: string): Database {
  return new Database(path, { readonly: true, strict: true });
}

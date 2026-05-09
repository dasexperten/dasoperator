import type { Env } from '../types';

// =============================================================================
// D1 query helpers with consistent error semantics.
// All helpers throw on error — caught by global error middleware.
// =============================================================================

export async function queryAll<T = Record<string, unknown>>(
  db: Env['DB'],
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const stmt = binds.length > 0 ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  const result = await stmt.all<T>();
  if (!result.success) {
    throw new Error(`D1 query failed: ${sql.slice(0, 80)}`);
  }
  return result.results ?? [];
}

export async function queryFirst<T = Record<string, unknown>>(
  db: Env['DB'],
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  const stmt = binds.length > 0 ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  const result = await stmt.first<T>();
  return result ?? null;
}

export async function execute(
  db: Env['DB'],
  sql: string,
  ...binds: unknown[]
): Promise<D1Result> {
  const stmt = binds.length > 0 ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  return stmt.run();
}

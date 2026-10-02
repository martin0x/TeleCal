// src/db/migrations.ts
// schema.sql is applied with IF NOT EXISTS, which cannot add a column to a
// table that already exists. This is the smallest migration mechanism that
// can: a list of columns, each added only when PRAGMA table_info says it is
// missing. Idempotent, so it runs on every boot.
import { Database } from "bun:sqlite"

export interface ColumnMigration {
  table: string
  column: string
  /** Column type and constraints, e.g. "INTEGER" or "TEXT DEFAULT ''". */
  ddl: string
}

export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: "food_items", column: "protein_g", ddl: "INTEGER" },
  { table: "users", column: "daily_protein_goal", ddl: "INTEGER" },
]

export function hasColumn(db: Database, table: string, column: string): boolean {
  // PRAGMA arguments cannot be bound; table names come from COLUMN_MIGRATIONS, never from input.
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return columns.some((c) => c.name === column)
}

export function runMigrations(
  db: Database,
  migrations: ColumnMigration[] = COLUMN_MIGRATIONS,
  log: (message: string) => void = console.log
): void {
  for (const m of migrations) {
    if (hasColumn(db, m.table, m.column)) continue
    db.run(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`)
    log(`[db] migrated: added ${m.table}.${m.column}`)
  }
}

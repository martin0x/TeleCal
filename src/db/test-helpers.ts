// src/db/test-helpers.ts
// Test-only: builds an in-memory database from the real schema, so tests
// cannot drift from production DDL the way hand-copied CREATE TABLE
// statements in the older test files have.
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"
import { runMigrations } from "./migrations"

export function createTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf-8")
  db.run(schema)
  // Same boot path as production: schema, then migrations (a no-op here).
  runMigrations(db)
  return db
}

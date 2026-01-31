// src/db/index.ts
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"

const DB_PATH = process.env.DB_PATH ?? "data/telecal.db"

export const db = new Database(DB_PATH, { create: true })

// Enable foreign keys
db.run("PRAGMA foreign_keys = ON")

export function initializeDatabase(): void {
  const schemaPath = join(import.meta.dir, "schema.sql")
  const schema = readFileSync(schemaPath, "utf-8")
  db.run(schema)
}

export function closeDatabase(): void {
  db.close()
}

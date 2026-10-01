# Protein Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every food item carries protein in grams, with the same goal, display and Mini App treatment calories have, and old rows get backfilled by AI.

**Architecture:** A nullable `protein_g` column on `food_items` and a `daily_protein_goal` on `users`, added by a new `PRAGMA table_info`-guarded migration step. All three AI providers return `protein_g` per item and gain a batch `estimateProtein` call that the `/admin backfill-protein` job uses in chunks of 25. Two shared format helpers render every item line and total in the bot; the web API gains additive fields and the Mini App a protein bar and a Calories/Protein toggle.

**Tech Stack:** Bun, `bun:sqlite`, grammY, OpenAI SDK 7 (Responses API), `@anthropic-ai/sdk`, `@google/generative-ai`, Chart.js 4 in a single HTML page.

**Spec:** `docs/superpowers/specs/2026-10-01-protein-tracking-design.md` — read it first. Its Decisions table explains every "why".

## Global Constraints

- Protein is always a whole number of grams. Coerce with `Math.round`; non-finite → `null`.
- `protein_g` is `null` only for "unknown": rows written before this feature, or an estimate the model did not fill. `0` is a real value.
- Per-item unit is bare `g` (`180 cal · 14 g`); totals spell it out (`335 cal · 28 g protein`); unknown renders `? g`.
- Calories are a ceiling, protein is a floor: `/week` and `/month` say "Under calorie goal" and "Protein goal met" (met = at or above).
- Web API changes are additive only. `total`, `daily`, and existing item fields keep their names and meaning.
- Every task ends with `bun test` green and `bunx tsc --noEmit` clean. Baseline before Task 1: **191 pass / 0 fail across 25 files**, tsc clean.
- Running totals in "Expected: … N total" lines are a guide, not a gate. The gate is **0 fail** and a clean tsc; if your count differs by a few, check that every new test in the task actually ran, then move on.
- Tests use `createTestDb()` from `src/db/test-helpers.ts`, never hand-copied DDL, except where a test deliberately builds a pre-feature database.
- `scripts/smoke-providers.ts` is outside `tsconfig.json`'s `include`; tsc will not catch a break there (Task 18 updates it by hand).
- Commit after every task with a conventional-commit subject and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work on a branch `feat/protein-tracking` off `main`. Do not push until Task 18 is done.

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `src/db/migrations.ts` | `runMigrations(db)`: add missing columns, idempotently |
| `src/db/migrations.test.ts` | Migration against a pre-feature DB |
| `src/ai/prompt.ts` | Prompt text shared by Anthropic and Gemini; protein batch prompt; batch input formatter |
| `src/ai/parse.ts` | `coerceProtein`, `normalizeItems`, `alignProteinBatch`, `stripFences` |
| `src/ai/parse.test.ts` | Unit tests for the above |
| `src/jobs/backfill-protein.ts` | `runProteinBackfill(deps, opts)` and `chunk` |
| `src/jobs/backfill-protein.test.ts` | Job tests with fakes |
| `src/bot/commands/admin-backfill.test.ts` | `/admin backfill-protein` replies |
| `src/bot/commands/today.test.ts` | `buildTodayMessage` |
| `src/bot/commands/stats.test.ts` | `buildStatsMessage` |
| `src/bot/commands/settings.test.ts` | Protein goal flow and keyboard |
| `src/bot/commands/edit.test.ts` | `parseEditInput` and the handler |
| `src/jobs/reminders.test.ts` | `formatReminderMessage` |
| `src/web/api.test.ts` | Additive API fields |

**Modified**

| File | Change |
|---|---|
| `src/db/schema.sql` | Two columns; `call_type` comment |
| `src/db/index.ts`, `src/db/test-helpers.ts` | Call `runMigrations` after the schema |
| `src/db/repositories/food-logs.ts` | `protein_g`; `getTotals`; `getDailyTotals` shape; backfill queries |
| `src/db/repositories/users.ts` | `daily_protein_goal` |
| `src/utils/format.ts` | `formatItemLine`, `formatTotals`, `sumTotals`, `formatProtein`, `formatGoalProgress`, `createProgressBar`; `formatItemsSummary` uses them |
| `src/ai/types.ts` | `protein_g`, `ProteinBatchResult`, `estimateProtein`, `"backfill"` |
| `src/ai/providers/{openai,anthropic,gemini}.ts` | Protein in prompts/schema; normalize; `estimateProtein` |
| `src/ai/service.ts` | Cache shape check; `estimateProtein`; `resolveProvider` |
| `src/bot/conversations/log-flow.ts`, `src/bot/commands/log.ts` | `confirm.totals`; button label; logged reply |
| `src/bot/commands/{today,stats,settings,edit,delete,admin}.ts` | As specced |
| `src/bot/index.ts` | Admin deps; `/start` text |
| `src/jobs/reminders.ts` | Protein line |
| `src/web/api.ts`, `src/web/views/app.html` | Additive fields; protein bar; toggle |
| `scripts/smoke-providers.ts`, `README.md`, `CLAUDE.md` | Docs and smoke output |
| Tests: `food-logs.test.ts`, `users.test.ts`, `test-helpers.test.ts`, `format.test.ts`, `service.test.ts`, `cache.test.ts`, provider tests, `retry-pending.test.ts`, `log.test.ts`, `delete.test.ts` | Updated fixtures and expectations |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
cd /Users/raymartvillos/Projects/TeleCal
git checkout -b feat/protein-tracking main
bun test 2>&1 | tail -3   # expect 191 pass
bunx tsc --noEmit         # expect no output
```

---

### Task 1: Schema columns and the migration step

**Files:**
- Modify: `src/db/schema.sql`
- Create: `src/db/migrations.ts`
- Create: `src/db/migrations.test.ts`
- Modify: `src/db/index.ts`
- Modify: `src/db/test-helpers.ts`
- Modify: `src/db/test-helpers.test.ts`

**Interfaces:**
- Produces: `runMigrations(db: Database, migrations?: ColumnMigration[]): void`, `hasColumn(db, table, column): boolean`, `COLUMN_MIGRATIONS`. Columns `food_items.protein_g INTEGER` (nullable) and `users.daily_protein_goal INTEGER` (nullable) exist on every database after boot and in every `createTestDb()`.

- [ ] **Step 1: Write the failing migration test**

Create `src/db/migrations.test.ts`:

```ts
// src/db/migrations.test.ts
import { describe, test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations, hasColumn } from "./migrations"

/** users, food_logs and food_items exactly as they were before protein tracking. */
function preProteinDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.run(`
    CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      ai_provider TEXT DEFAULT 'gemini',
      daily_goal INTEGER,
      reminder_time TEXT,
      reminder_mention INTEGER DEFAULT 1,
      timezone TEXT DEFAULT 'Asia/Manila',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE food_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      logged_at TEXT DEFAULT (datetime('now')),
      target_date TEXT NOT NULL
    );
    CREATE TABLE food_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      calories INTEGER NOT NULL,
      emoji TEXT,
      FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
    );
  `)
  db.run("INSERT INTO users (telegram_id, username, daily_goal) VALUES (42, 'maria', 2000)")
  db.run("INSERT INTO food_logs (telegram_id, chat_id, target_date) VALUES (42, 555, '2026-09-30')")
  db.run("INSERT INTO food_items (log_id, description, calories, emoji) VALUES (1, 'Ramen', 520, '🍜')")
  return db
}

describe("runMigrations", () => {
  test("adds protein_g and daily_protein_goal to a pre-feature database", () => {
    const db = preProteinDb()
    expect(hasColumn(db, "food_items", "protein_g")).toBe(false)
    expect(hasColumn(db, "users", "daily_protein_goal")).toBe(false)

    runMigrations(db)

    expect(hasColumn(db, "food_items", "protein_g")).toBe(true)
    expect(hasColumn(db, "users", "daily_protein_goal")).toBe(true)
  })

  test("leaves existing rows intact, with null in the new columns", () => {
    const db = preProteinDb()
    runMigrations(db)

    expect(db.prepare("SELECT description, calories, protein_g FROM food_items").get()).toEqual({
      description: "Ramen",
      calories: 520,
      protein_g: null,
    })
    expect(db.prepare("SELECT daily_goal, daily_protein_goal FROM users").get()).toEqual({
      daily_goal: 2000,
      daily_protein_goal: null,
    })
  })

  test("is a no-op the second time", () => {
    const db = preProteinDb()
    runMigrations(db)

    expect(() => runMigrations(db)).not.toThrow()
    const cols = db.prepare("PRAGMA table_info(food_items)").all() as { name: string }[]
    expect(cols.filter((c) => c.name === "protein_g")).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/db/migrations.test.ts`
Expected: FAIL — `Cannot find module './migrations'`.

- [ ] **Step 3: Write the migration module**

Create `src/db/migrations.ts`:

```ts
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

export function runMigrations(db: Database, migrations: ColumnMigration[] = COLUMN_MIGRATIONS): void {
  for (const m of migrations) {
    if (hasColumn(db, m.table, m.column)) continue
    db.run(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`)
    console.log(`[db] migrated: added ${m.table}.${m.column}`)
  }
}
```

- [ ] **Step 4: Run the migration test**

Run: `bun test src/db/migrations.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Add the columns to `schema.sql`**

In `src/db/schema.sql`, change the `users` table:

```sql
  daily_goal INTEGER,
  daily_protein_goal INTEGER,
  reminder_time TEXT,
```

Change the `food_items` table:

```sql
  calories INTEGER NOT NULL,
  protein_g INTEGER,            -- whole grams; null = not yet estimated
  emoji TEXT,
```

Change the `ai_usage.call_type` comment:

```sql
  call_type TEXT NOT NULL,      -- estimate | clarify | edit | retry | backfill
```

- [ ] **Step 6: Run migrations after the schema in both entry points**

`src/db/index.ts`:

```ts
// src/db/index.ts
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"
import { runMigrations } from "./migrations"

const DB_PATH = process.env.DB_PATH ?? "data/telecal.db"

export const db = new Database(DB_PATH, { create: true })

// Enable foreign keys
db.run("PRAGMA foreign_keys = ON")

export function initializeDatabase(): void {
  const schemaPath = join(import.meta.dir, "schema.sql")
  const schema = readFileSync(schemaPath, "utf-8")
  db.run(schema)
  // Fresh databases got every column from the schema; existing ones get the
  // additions here.
  runMigrations(db)
}

export function closeDatabase(): void {
  db.close()
}
```

`src/db/test-helpers.ts`:

```ts
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
```

- [ ] **Step 7: Assert the columns in the test-helper test**

Append to the `describe("createTestDb")` block in `src/db/test-helpers.test.ts`:

```ts
  test("food_items and users carry the protein columns", () => {
    const db = createTestDb()
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    expect(names("food_items")).toContain("protein_g")
    expect(names("users")).toContain("daily_protein_goal")
  })
```

- [ ] **Step 8: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 195 pass (191 + 3 + 1), tsc clean.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/migrations.ts src/db/migrations.test.ts src/db/index.ts src/db/test-helpers.ts src/db/test-helpers.test.ts
git commit -m "feat(db): add protein columns and a column migration step" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Protein on food items and day totals

**Files:**
- Modify: `src/db/repositories/food-logs.ts`
- Modify: `src/db/repositories/food-logs.test.ts`
- Modify (minimal, keep compiling): `src/bot/commands/today.ts:22`, `src/bot/commands/stats.ts:49`, `src/jobs/reminders.ts:79`, `src/web/api.ts:54-64`

**Interfaces:**
- Produces:
  - `FoodItem.protein_g?: number | null` (optional on input because items parsed from pre-feature `conversation_state` rows omit it; every row read back has it as `number | null`).
  - `export interface DayTotals { calories: number; protein: number }`
  - `getTotals(telegramId, targetDate): DayTotals` — replaces `getTotalCalories`.
  - `getDailyTotals(telegramId, start, end): Record<string, DayTotals>` — was `Record<string, number>`.
  - `updateItem(itemId, updates: Partial<{ description; calories; protein_g: number | null; emoji }>)`
  - `listDescriptionsMissingProtein(): string[]` — distinct, ordered.
  - `countItemsMissingProtein(): number`
  - `setProteinForDescription(description: string, proteinG: number): number` — rows changed; only touches `protein_g IS NULL`.

- [ ] **Step 1: Rewrite the repository test on `createTestDb` and add protein cases**

Replace `src/db/repositories/food-logs.test.ts` entirely:

```ts
// src/db/repositories/food-logs.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { FoodLogsRepository, FoodItem } from "./food-logs"

describe("FoodLogsRepository", () => {
  let db: Database
  let repo: FoodLogsRepository

  beforeEach(() => {
    db = createTestDb()
    repo = new FoodLogsRepository(db)
  })

  test("creates log with items", () => {
    const items: FoodItem[] = [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 120, protein_g: 4, emoji: "🍞" },
    ]
    const log = repo.create(123, 456, "2026-01-31", items)
    expect(log.id).toBeDefined()
    expect(log.items.length).toBe(2)
    expect(log.items[0].protein_g).toBe(12)
  })

  test("stores null protein when an item has none", () => {
    const log = repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180, emoji: "🍳" }])
    expect(log.items[0].protein_g).toBeNull()
    expect(repo.getByDate(123, "2026-01-31")[0].items[0].protein_g).toBeNull()
  })

  test("gets entries for a specific date", () => {
    const items = [{ description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" }]
    repo.create(123, 456, "2026-01-31", items)
    repo.create(123, 456, "2026-01-30", items)

    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries.length).toBe(1)
    expect(entries[0].items[0].protein_g).toBe(12)
  })

  test("getTotals sums calories and protein, skipping null protein", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 120, protein_g: 4, emoji: "🍞" },
      { description: "Mystery", calories: 50, protein_g: null },
    ])
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 350, protein: 16 })
  })

  test("getTotals returns zeros for an empty day", () => {
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 0, protein: 0 })
  })

  test("gets daily totals for date range", () => {
    repo.create(123, 456, "2026-01-30", [{ description: "Food", calories: 1000, protein_g: 60, emoji: "🍕" }])
    repo.create(123, 456, "2026-01-31", [{ description: "Food", calories: 1500, protein_g: null, emoji: "🍕" }])

    const totals = repo.getDailyTotals(123, "2026-01-25", "2026-01-31")
    expect(totals["2026-01-30"]).toEqual({ calories: 1000, protein: 60 })
    expect(totals["2026-01-31"]).toEqual({ calories: 1500, protein: 0 })
  })

  test("deletes a food item", () => {
    const log = repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ])
    repo.deleteItem(log.items[0].id!)
    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries[0].items.length).toBe(1)
  })

  test("updates calories, protein and description independently", () => {
    const log = repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" }])
    const id = log.items[0].id!

    repo.updateItem(id, { calories: 200 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ calories: 200, protein_g: 12 })

    repo.updateItem(id, { protein_g: 15 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ calories: 200, protein_g: 15 })

    repo.updateItem(id, { protein_g: null })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0].protein_g).toBeNull()
  })

  test("getItemForUser returns the item only for its owner", () => {
    const log = repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const itemId = log.items[0].id!

    expect(repo.getItemForUser(itemId, 1)).toMatchObject({
      id: itemId,
      description: "Ramen",
      calories: 520,
      protein_g: 22,
      log_id: log.id,
    })
    expect(repo.getItemForUser(itemId, 2)).toBeNull()
    expect(repo.getItemForUser(99999, 1)).toBeNull()
  })

  describe("backfill queries", () => {
    test("lists distinct descriptions missing protein, in order", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Apple", calories: 95 },
        { description: "Ramen", calories: 540 },
        { description: "Eggs", calories: 180, protein_g: 12 },
      ])
      expect(repo.listDescriptionsMissingProtein()).toEqual(["Apple", "Ramen"])
      expect(repo.countItemsMissingProtein()).toBe(3)
    })

    test("setProteinForDescription fills only null rows with that exact description", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Ramen", calories: 540 },
        { description: "ramen", calories: 500 },
        { description: "Ramen", calories: 600, protein_g: 30 },
      ])

      expect(repo.setProteinForDescription("Ramen", 22)).toBe(2)

      const items = repo.getItemsByDate(1, "2026-09-25")
      expect(items.map((i) => i.protein_g)).toEqual([22, 22, null, 30])
      expect(repo.listDescriptionsMissingProtein()).toEqual(["ramen"])
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/db/repositories/food-logs.test.ts`
Expected: FAIL — `repo.getTotals is not a function`, protein assertions fail.

- [ ] **Step 3: Implement the repository changes**

In `src/db/repositories/food-logs.ts`:

Replace the `FoodItem` interface and add `DayTotals`:

```ts
export interface FoodItem {
  id?: number
  description: string
  calories: number
  /** Whole grams. null = unknown (pre-feature row or model miss). Optional on input only. */
  protein_g?: number | null
  emoji?: string
}

export interface DayTotals {
  calories: number
  protein: number
}
```

In `create`, change the insert and the row type:

```ts
    const itemStmt = this.db.prepare(`
      INSERT INTO food_items (log_id, description, calories, protein_g, emoji)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        item.protein_g ?? null,
        item.emoji ?? null
      ) as { id: number; description: string; calories: number; protein_g: number | null; emoji: string | null }
      return { ...row, emoji: row.emoji ?? undefined }
    })
```

In `getByDate`, add `protein_g: number | null` to the items row type:

```ts
      const items = itemsStmt.all(log.id) as {
        id: number
        description: string
        calories: number
        protein_g: number | null
        emoji: string | null
      }[]
```

Replace `getTotalCalories` and `getDailyTotals`:

```ts
  getTotals(telegramId: number, targetDate: string): DayTotals {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(fi.calories), 0) as calories,
             COALESCE(SUM(fi.protein_g), 0) as protein
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
    `)
    return stmt.get(telegramId, targetDate) as DayTotals
  }

  getDailyTotals(
    telegramId: number,
    startDate: string,
    endDate: string
  ): Record<string, DayTotals> {
    const stmt = this.db.prepare(`
      SELECT fl.target_date,
             COALESCE(SUM(fi.calories), 0) as calories,
             COALESCE(SUM(fi.protein_g), 0) as protein
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ?
        AND fl.target_date >= ?
        AND fl.target_date <= ?
      GROUP BY fl.target_date
    `)
    const rows = stmt.all(telegramId, startDate, endDate) as {
      target_date: string
      calories: number
      protein: number
    }[]
    return Object.fromEntries(rows.map((r) => [r.target_date, { calories: r.calories, protein: r.protein }]))
  }
```

Replace `updateItem`:

```ts
  updateItem(
    itemId: number,
    updates: Partial<{ description: string; calories: number; protein_g: number | null; emoji: string }>
  ): void {
    // Explicit allowlist - TypeScript enforces only these columns can be used
    const allowedColumns = ["description", "calories", "protein_g", "emoji"] as const
    type AllowedColumn = (typeof allowedColumns)[number]

    const columnUpdates: { column: AllowedColumn; value: string | number | null }[] = []

    if (updates.description !== undefined) {
      columnUpdates.push({ column: "description", value: updates.description })
    }
    if (updates.calories !== undefined) {
      columnUpdates.push({ column: "calories", value: updates.calories })
    }
    if (updates.protein_g !== undefined) {
      columnUpdates.push({ column: "protein_g", value: updates.protein_g })
    }
    if (updates.emoji !== undefined) {
      columnUpdates.push({ column: "emoji", value: updates.emoji })
    }

    if (columnUpdates.length === 0) return

    // TypeScript guarantees column names are from the literal union
    const setClause = columnUpdates.map((u) => `${u.column} = ?`).join(", ")
    const values = columnUpdates.map((u) => u.value)

    const stmt = this.db.prepare(`UPDATE food_items SET ${setClause} WHERE id = ?`)
    stmt.run(...values, itemId)
  }
```

Append the backfill queries before the closing brace of the class:

```ts
  // --- Protein backfill -----------------------------------------------------

  /** Distinct descriptions of items whose protein is still unknown. */
  listDescriptionsMissingProtein(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT description FROM food_items WHERE protein_g IS NULL ORDER BY description")
      .all() as { description: string }[]
    return rows.map((r) => r.description)
  }

  countItemsMissingProtein(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM food_items WHERE protein_g IS NULL").get() as { n: number }
    return row.n
  }

  /**
   * Fills every still-null row with this exact description. Exact match on
   * purpose: it is the string the model was asked about. Returns rows changed.
   */
  setProteinForDescription(description: string, proteinG: number): number {
    const result = this.db
      .prepare("UPDATE food_items SET protein_g = ? WHERE protein_g IS NULL AND description = ?")
      .run(proteinG, description)
    return result.changes
  }
```

- [ ] **Step 4: Keep the four callers compiling (display comes later)**

`src/bot/commands/today.ts` line 22:

```ts
    const totalCalories = foodLogsRepo.getTotals(userId, today).calories
```

`src/jobs/reminders.ts` line 79:

```ts
        const totalCalories = foodLogsRepo.getTotals(user.telegram_id, userToday).calories
```

`src/bot/commands/stats.ts` — after line 49, add a shim and point the rest of the function at it:

```ts
  const dailyTotalsFull = foodLogsRepo.getDailyTotals(userId, startDate, endDate)
  // Task 12 replaces this with protein-aware rendering.
  const dailyTotals: Record<string, number> = Object.fromEntries(
    Object.entries(dailyTotalsFull).map(([date, t]) => [date, t.calories])
  )
```

(Delete the original `const dailyTotals = foodLogsRepo.getDailyTotals(...)` line so the name is declared once.)

`src/web/api.ts` lines 60-64:

```ts
      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      for (const date of dateRange) {
        daily[date] = dailyTotals[date]?.calories ?? 0
      }
```

- [ ] **Step 5: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (food-logs file now has 11 tests, was 7 → 199 total), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/food-logs.ts src/db/repositories/food-logs.test.ts src/bot/commands/today.ts src/bot/commands/stats.ts src/jobs/reminders.ts src/web/api.ts
git commit -m "feat(db): protein on food items and day totals" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Daily protein goal on users

**Files:**
- Modify: `src/db/repositories/users.ts`
- Modify: `src/db/repositories/users.test.ts`

**Interfaces:**
- Produces: `User.daily_protein_goal: number | null`; `updateSettings(id, { daily_protein_goal?: number | null })`.

- [ ] **Step 1: Add the column to the test fixture and a failing test**

In `src/db/repositories/users.test.ts`, inside the inline `CREATE TABLE users (...)` fixture, add after `daily_goal INTEGER,`:

```sql
        daily_protein_goal INTEGER,
```

Append inside the `describe("UsersRepository")` block:

```ts
  test("round-trips the daily protein goal", () => {
    repo.upsert(123, "john")
    expect(repo.findById(123)!.daily_protein_goal).toBeNull()

    repo.updateSettings(123, { daily_protein_goal: 120 })
    expect(repo.findById(123)!.daily_protein_goal).toBe(120)

    repo.updateSettings(123, { daily_protein_goal: null })
    expect(repo.findById(123)!.daily_protein_goal).toBeNull()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/db/repositories/users.test.ts`
Expected: FAIL — `daily_protein_goal` stays null after update (unknown setting ignored) or a type error on `daily_protein_goal`.

- [ ] **Step 3: Implement**

In `src/db/repositories/users.ts`:

Add to both `User` and `UserRow`, after `daily_goal`:

```ts
  daily_protein_goal: number | null
```

In `updateSettings`, add to the `settings` type after `daily_goal`:

```ts
      daily_protein_goal: number | null
```

Add `"daily_protein_goal",` to `allowedColumns` after `"daily_goal",`, and after the `daily_goal` push:

```ts
    if (settings.daily_protein_goal !== undefined) {
      columnUpdates.push({ column: "daily_protein_goal", value: settings.daily_protein_goal })
    }
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 200 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/users.ts src/db/repositories/users.test.ts
git commit -m "feat(db): daily protein goal on users" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Shared format helpers

**Files:**
- Modify: `src/utils/format.ts`
- Modify: `src/utils/format.test.ts`
- Modify: `src/jobs/retry-pending.test.ts:59-82` (expected HTML string)

**Interfaces:**
- Produces (all exported from `src/utils/format.ts`):
  - `SummaryItem { description: string; calories: number; protein_g?: number | null; emoji?: string | null }`
  - `sumTotals(items): { calories: number; protein: number }` — null/undefined protein counts as 0.
  - `formatProtein(p: number | null | undefined): string` → `"14 g"` or `"? g"`.
  - `formatItemLine(item: SummaryItem): string` → `🍳 2 scrambled eggs — 180 cal · 14 g` (plain text, not escaped).
  - `formatTotals(t: { calories: number; protein: number }): string` → `335 cal · 28 g protein` (en-US thousands separators).
  - `formatGoalProgress({ emoji, label, current, goal, unit }): string` — see Step 3.
  - `createProgressBar(percentage: number): string` — 10 blocks of `█`/`░` (moved from `today.ts`; `today.ts` keeps its own copy until Task 11).
  - `formatItemsSummary(items, opts)` — same signature; lines now carry protein; the bold total uses `formatTotals`.

- [ ] **Step 1: Update and extend the format tests**

In `src/utils/format.test.ts`, change the import line to:

```ts
import {
  formatUsd,
  formatTokens,
  escapeHtml,
  formatItemsSummary,
  shortHash,
  sumTotals,
  formatProtein,
  formatItemLine,
  formatTotals,
  formatGoalProgress,
  createProgressBar,
} from "./format"
```

Replace the whole `describe("formatItemsSummary")` block with:

```ts
describe("formatItemsSummary", () => {
  const items = [
    { description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
    { description: "Black coffee", calories: 5, protein_g: 0, emoji: "☕" },
  ]

  test("puts items in a blockquote with a bold total beneath", () => {
    expect(formatItemsSummary(items)).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal · 14 g\n☕ Black coffee — 5 cal · 0 g</blockquote>\n" +
        "<b>Total: 185 cal · 14 g protein</b>"
    )
  })

  test("escapes descriptions", () => {
    const out = formatItemsSummary([{ description: "Mac & cheese", calories: 400, protein_g: 18, emoji: "🧀" }])
    expect(out).toContain("🧀 Mac &amp; cheese — 400 cal · 18 g")
  })

  test("falls back to 🍽️ when an item has no emoji", () => {
    expect(formatItemsSummary([{ description: "Rice", calories: 200, protein_g: 4 }])).toContain("🍽️ Rice — 200 cal · 4 g")
    expect(formatItemsSummary([{ description: "Rice", calories: 200, protein_g: 4, emoji: null }])).toContain(
      "🍽️ Rice — 200 cal · 4 g"
    )
  })

  test("renders unknown protein as ? g and leaves it out of the total", () => {
    expect(formatItemsSummary([{ description: "Rice", calories: 200 }, { description: "Egg", calories: 70, protein_g: 6 }])).toBe(
      "<blockquote>🍽️ Rice — 200 cal · ? g\n🍽️ Egg — 70 cal · 6 g</blockquote>\n<b>Total: 270 cal · 6 g protein</b>"
    )
  })

  test("strikes through items and total when struck", () => {
    expect(formatItemsSummary(items, { struck: true })).toBe(
      "<blockquote><s>🍳 2 scrambled eggs — 180 cal · 14 g\n☕ Black coffee — 5 cal · 0 g</s></blockquote>\n" +
        "<b><s>Total: 185 cal · 14 g protein</s></b>"
    )
  })

  test("contains no width-dependent rule", () => {
    expect(formatItemsSummary(items)).not.toContain("─")
  })

  test("tolerates a non-string description without throwing", () => {
    expect(
      formatItemsSummary([{ description: 42 as unknown as string, calories: 1 }])
    ).toContain("🍽️ 42 — 1 cal · ? g")
  })
})

describe("sumTotals", () => {
  test("sums calories and known protein", () => {
    expect(sumTotals([{ calories: 100, protein_g: 10 }, { calories: 50, protein_g: null }, { calories: 25 }])).toEqual({
      calories: 175,
      protein: 10,
    })
  })

  test("is zero for no items", () => {
    expect(sumTotals([])).toEqual({ calories: 0, protein: 0 })
  })
})

describe("formatProtein", () => {
  test("renders grams, including zero", () => {
    expect(formatProtein(14)).toBe("14 g")
    expect(formatProtein(0)).toBe("0 g")
  })

  test("renders unknown as ? g", () => {
    expect(formatProtein(null)).toBe("? g")
    expect(formatProtein(undefined)).toBe("? g")
    expect(formatProtein(Number.NaN)).toBe("? g")
  })
})

describe("formatItemLine", () => {
  test("renders emoji, description, calories and protein", () => {
    expect(formatItemLine({ description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" })).toBe(
      "🍳 2 scrambled eggs — 180 cal · 14 g"
    )
  })

  test("falls back to the plate emoji and ? g", () => {
    expect(formatItemLine({ description: "Rice", calories: 200 })).toBe("🍽️ Rice — 200 cal · ? g")
  })
})

describe("formatTotals", () => {
  test("spells out protein and groups thousands", () => {
    expect(formatTotals({ calories: 335, protein: 28 })).toBe("335 cal · 28 g protein")
    expect(formatTotals({ calories: 1450, protein: 1020 })).toBe("1,450 cal · 1,020 g protein")
  })
})

describe("createProgressBar", () => {
  test("fills one block per 10 percent, clamped to 10", () => {
    expect(createProgressBar(0)).toBe("░░░░░░░░░░")
    expect(createProgressBar(73)).toBe("███████░░░")
    expect(createProgressBar(100)).toBe("██████████")
    expect(createProgressBar(140)).toBe("██████████")
  })
})

describe("formatGoalProgress", () => {
  const base = { emoji: "📊", label: "Calories", unit: "cal" }

  test("is a single line without a goal", () => {
    expect(formatGoalProgress({ ...base, current: 1450, goal: null })).toBe("📊 Calories: 1,450 cal")
    expect(formatGoalProgress({ ...base, current: 1450, goal: undefined })).toBe("📊 Calories: 1,450 cal")
  })

  test("shows the bar and remaining amount under the goal", () => {
    expect(formatGoalProgress({ ...base, current: 1450, goal: 2000 })).toBe(
      "📊 Calories: 1,450 / 2,000 cal\n███████░░░ 73%\n✨ 550 cal remaining"
    )
  })

  test("shows the overage above the goal", () => {
    expect(formatGoalProgress({ emoji: "💪", label: "Protein", unit: "g", current: 130, goal: 120 })).toBe(
      "💪 Protein: 130 / 120 g\n██████████ 108%\n⚠️ 10 g over goal"
    )
  })

  test("celebrates an exact hit", () => {
    expect(formatGoalProgress({ ...base, current: 2000, goal: 2000 })).toBe(
      "📊 Calories: 2,000 / 2,000 cal\n██████████ 100%\n🎯 Goal reached!"
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/utils/format.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement the helpers**

Replace everything from `export interface SummaryItem` through the end of `formatItemsSummary` in `src/utils/format.ts` with:

```ts
export interface SummaryItem {
  description: string
  calories: number
  /** Whole grams. null or undefined = unknown. */
  protein_g?: number | null
  emoji?: string | null
}

const n = (value: number) => value.toLocaleString("en-US")

function isKnownProtein(protein: number | null | undefined): protein is number {
  return typeof protein === "number" && Number.isFinite(protein)
}

/** Calories and known protein across items. Unknown protein counts as 0. */
export function sumTotals(items: Pick<SummaryItem, "calories" | "protein_g">[]): { calories: number; protein: number } {
  return items.reduce(
    (acc, item) => ({
      calories: acc.calories + item.calories,
      protein: acc.protein + (isKnownProtein(item.protein_g) ? item.protein_g : 0),
    }),
    { calories: 0, protein: 0 }
  )
}

export function formatProtein(protein: number | null | undefined): string {
  return isKnownProtein(protein) ? `${protein} g` : "? g"
}

/**
 * One item, plain text: `🍳 2 scrambled eggs — 180 cal · 14 g`. String() guards
 * against a model that returns a number where a string belongs.
 */
export function formatItemLine(item: SummaryItem): string {
  return `${String(item.emoji ?? "🍽️")} ${String(item.description)} — ${String(item.calories)} cal · ${formatProtein(item.protein_g)}`
}

/** `335 cal · 28 g protein` — the total spells out the unit the item lines abbreviate. */
export function formatTotals(totals: { calories: number; protein: number }): string {
  return `${n(totals.calories)} cal · ${n(totals.protein)} g protein`
}

/**
 * Items in a quote box with a bold total beneath, for messages sent with
 * parse_mode "HTML". This replaces a row of ─ characters, which wrapped onto a
 * second line on narrow screens: no character count fits every client, and a
 * blockquote does not depend on width at all.
 */
export function formatItemsSummary(items: SummaryItem[], opts: { struck?: boolean } = {}): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items.map((item) => escapeHtml(formatItemLine(item))).join("\n")
  return `<blockquote>${strike(lines)}</blockquote>\n<b>${strike(`Total: ${formatTotals(sumTotals(items))}`)}</b>`
}

export function createProgressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(Math.round(percentage / 10), 10))
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

/**
 * A goal block for /today and friends. One line without a goal; with a goal,
 * the headline, a 10-block bar with percentage, and a remaining/over/reached
 * line. Same shape for calories (a ceiling) and protein (a floor) — /today says
 * "remaining" for both; the weekly stats carry the direction.
 */
export function formatGoalProgress(opts: {
  emoji: string
  label: string
  current: number
  goal: number | null | undefined
  unit: string
}): string {
  const { emoji, label, current, goal, unit } = opts
  if (!goal) return `${emoji} ${label}: ${n(current)} ${unit}`

  const percentage = Math.round((current / goal) * 100)
  const remaining = goal - current
  let out = `${emoji} ${label}: ${n(current)} / ${n(goal)} ${unit}\n${createProgressBar(percentage)} ${percentage}%\n`
  if (remaining > 0) out += `✨ ${n(remaining)} ${unit} remaining`
  else if (remaining < 0) out += `⚠️ ${n(Math.abs(remaining))} ${unit} over goal`
  else out += `🎯 Goal reached!`
  return out
}
```

- [ ] **Step 4: Fix the retry-pending expectation**

In `src/jobs/retry-pending.test.ts`, the second test's mock and expectation:

```ts
  const estimate = mock(() =>
    Promise.resolve({
      items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high" as const,
    })
  )
```

```ts
  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    42,
    "✅ Processed your saved entry — logged to Mon, Sep 21:\n" +
      "<blockquote>🍗 Chicken adobo — 420 cal · 38 g</blockquote>\n<b>Total: 420 cal · 38 g protein</b>",
    { parse_mode: "HTML" }
  )
```

- [ ] **Step 5: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (format file grows from 14 to 29 tests → 215 total), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts src/jobs/retry-pending.test.ts
git commit -m "feat(format): shared item line, totals and goal progress helpers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Providers return `protein_g`

**Files:**
- Modify: `src/ai/types.ts`
- Create: `src/ai/parse.ts`
- Create: `src/ai/parse.test.ts`
- Create: `src/ai/prompt.ts`
- Modify: `src/ai/providers/openai.ts`, `src/ai/providers/anthropic.ts`, `src/ai/providers/gemini.ts`
- Modify: `src/ai/providers/openai.test.ts`, `src/ai/providers/anthropic.test.ts`, `src/ai/providers/gemini.test.ts`
- Modify (fixtures): `src/ai/service.test.ts:8-12`, `src/db/repositories/cache.test.ts:11-15`

**Interfaces:**
- Produces:
  - `FoodEstimate.protein_g: number | null` (required on the AI output type).
  - `CallType` gains `"backfill"`.
  - `src/ai/parse.ts`: `coerceProtein(value: unknown): number | null`, `normalizeItems(items: unknown): FoodEstimate[]`, `stripFences(text: string): string`.
  - `src/ai/prompt.ts`: `ESTIMATE_JSON_PROMPT` (Anthropic + Gemini system prompt), `PROTEIN_RULE` (one line, also appended to OpenAI's instructions).
  - OpenAI `ESTIMATE_SCHEMA` has `protein_g: { type: "number" }` in `required`.

- [ ] **Step 1: Write the parse tests**

Create `src/ai/parse.test.ts`:

```ts
// src/ai/parse.test.ts
import { describe, test, expect } from "bun:test"
import { coerceProtein, normalizeItems, stripFences } from "./parse"

describe("coerceProtein", () => {
  test("rounds finite numbers to whole grams and clamps at zero", () => {
    expect(coerceProtein(14)).toBe(14)
    expect(coerceProtein(13.6)).toBe(14)
    expect(coerceProtein(0)).toBe(0)
    expect(coerceProtein(-3)).toBe(0)
  })

  test("accepts a numeric string", () => {
    expect(coerceProtein("22")).toBe(22)
    expect(coerceProtein(" 7.4 ")).toBe(7)
  })

  test("returns null for anything else", () => {
    expect(coerceProtein(undefined)).toBeNull()
    expect(coerceProtein(null)).toBeNull()
    expect(coerceProtein("lots")).toBeNull()
    expect(coerceProtein("")).toBeNull()
    expect(coerceProtein(Number.NaN)).toBeNull()
    expect(coerceProtein(Number.POSITIVE_INFINITY)).toBeNull()
    expect(coerceProtein({})).toBeNull()
  })
})

describe("normalizeItems", () => {
  test("coerces protein_g on every item and keeps other fields", () => {
    expect(
      normalizeItems([
        { description: "Eggs", calories: 180, protein_g: 12.4, emoji: "🍳" },
        { description: "Rice", calories: 200 },
      ])
    ).toEqual([
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Rice", calories: 200, protein_g: null },
    ])
  })

  test("returns an empty array for a missing or non-array items field", () => {
    expect(normalizeItems(undefined)).toEqual([])
    expect(normalizeItems("nope")).toEqual([])
  })
})

describe("stripFences", () => {
  test("removes a ```json fence", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
  })

  test("leaves bare JSON alone", () => {
    expect(stripFences('  {"a":1} ')).toBe('{"a":1}')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ai/parse.test.ts`
Expected: FAIL — `Cannot find module './parse'`.

- [ ] **Step 3: Create `parse.ts`**

```ts
// src/ai/parse.ts
// Model output is untrusted: a field can be missing, a string, or NaN. These
// helpers turn whatever came back into the shapes the rest of the app trusts.
import type { FoodEstimate } from "./types"

/** Whole grams, or null when the value is not a finite number (or numeric string). */
export function coerceProtein(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof num !== "number" || !Number.isFinite(num)) return null
  return Math.max(0, Math.round(num))
}

/** Items from a parsed estimate, each with protein_g coerced. Non-arrays become []. */
export function normalizeItems(items: unknown): FoodEstimate[] {
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    const raw = item as Record<string, unknown>
    return { ...(raw as unknown as FoodEstimate), protein_g: coerceProtein(raw.protein_g) }
  })
}

/** Strips a markdown code fence that prose-prompted models sometimes wrap JSON in. */
export function stripFences(text: string): string {
  let s = text.trim()
  if (s.startsWith("```")) {
    s = s.replace(/```json?\n?/g, "").replace(/```$/g, "").trim()
  }
  return s
}
```

- [ ] **Step 4: Run the parse tests**

Run: `bun test src/ai/parse.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Update `types.ts`**

In `src/ai/types.ts`, replace `FoodEstimate` and `CallType`:

```ts
export interface FoodEstimate {
  description: string
  calories: number
  /** Whole grams. null when the model gave nothing usable; the backfill fills it later. */
  protein_g: number | null
  emoji?: string
}
```

```ts
export type CallType = "estimate" | "clarify" | "edit" | "retry" | "backfill"
```

Fix the two fixtures that are typed `EstimationResult`:

`src/ai/service.test.ts` line 9: `items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, emoji: "🍗" }],`

`src/db/repositories/cache.test.ts` line 12: `items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, emoji: "🍗" }],` and line 33: `items: [{ description: "Adobo", calories: 500, protein_g: 40 }]`.

- [ ] **Step 6: Create `prompt.ts`**

```ts
// src/ai/prompt.ts
// Prompt text shared across providers. Anthropic and Gemini ask for JSON in
// prose and previously carried byte-identical copies of this text in two
// files; OpenAI's strict schema carries the shape, so it keeps its own shorter
// instructions and shares only the protein rule.

export const PROTEIN_RULE = "- protein_g: estimated grams of protein for the item, as a whole number"

export const ESTIMATE_JSON_PROMPT = `You are a nutrition expert that estimates calories and protein in food.

When given a food description, respond with ONLY a JSON object (no markdown, no explanation) containing:
- items: array of {description, calories, protein_g, emoji} for each food item
- needsClarification: boolean - true if the description is too vague
- clarificationQuestion: string - question to ask if clarification needed
- confidence: "high" | "medium" | "low"

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include relevant emoji for each food item
- If multiple items mentioned, break them down separately
- If quantity/size is unclear, ask for clarification
${PROTEIN_RULE}

Example input: "chicken sandwich and fries"
Example output:
{"items":[{"description":"Chicken sandwich","calories":450,"protein_g":28,"emoji":"🥪"},{"description":"French fries (medium)","calories":365,"protein_g":4,"emoji":"🍟"}],"needsClarification":false,"confidence":"medium"}`
```

- [ ] **Step 7: Add protein tests to each provider**

Append to `src/ai/providers/openai.test.ts` inside `describe("OpenAIProvider")`:

```ts
  test("requires protein_g in the strict schema", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    const itemSchema = calls[0].text.format.schema.properties.items.items
    expect(itemSchema.properties.protein_g).toEqual({ type: "number" })
    expect(itemSchema.required).toContain("protein_g")
  })

  test("surfaces protein_g on each item, rounded", async () => {
    const reply = JSON.stringify({
      items: [{ description: "Scrambled eggs", calories: 180, protein_g: 12.6, emoji: "🍳" }],
      needsClarification: false,
      clarificationQuestion: "",
      confidence: "high",
    })
    const result = await new OpenAIProvider(fakeClient(reply).client).estimate("two scrambled eggs")
    expect(result.estimate.items[0].protein_g).toBe(13)
  })

  test("mentions protein in the instructions", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")
    expect(calls[0].instructions).toContain("protein_g")
  })
```

Append to `src/ai/providers/anthropic.test.ts` inside `describe("AnthropicProvider")`:

```ts
  test("surfaces protein_g and nulls a missing one", async () => {
    const reply = JSON.stringify({
      items: [
        { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
        { description: "Toast", calories: 120, emoji: "🍞" },
      ],
      needsClarification: false,
      confidence: "high",
    })
    const result = await new AnthropicProvider(fakeClient(reply)).estimate("eggs and toast")
    expect(result.estimate.items.map((i) => i.protein_g)).toEqual([12, null])
  })

  test("asks for protein_g in the system prompt", async () => {
    const calls: any[] = []
    const client = {
      messages: {
        create: async (args: any) => {
          calls.push(args)
          return { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: VALID_REPLY }], usage: { input_tokens: 1, output_tokens: 1 } }
        },
      },
    } as unknown as Anthropic
    await new AnthropicProvider(client).estimate("two eggs")
    expect(calls[0].system).toContain("protein_g")
  })
```

Append to `src/ai/providers/gemini.test.ts` inside `describe("GeminiProvider")`:

```ts
  test("surfaces protein_g and nulls a non-numeric one", async () => {
    const reply = JSON.stringify({
      items: [
        { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
        { description: "Toast", calories: 120, protein_g: "some", emoji: "🍞" },
      ],
      needsClarification: false,
      confidence: "high",
    })
    const result = await new GeminiProvider(fakeClient(reply)).estimate("eggs and toast")
    expect(result.estimate.items.map((i) => i.protein_g)).toEqual([12, null])
  })

  test("asks for protein_g in the system instruction", async () => {
    const seen: any[] = []
    const client = {
      getGenerativeModel: (opts: any) => {
        seen.push(opts)
        return {
          generateContent: async () => ({ response: { text: () => VALID_REPLY, usageMetadata: {} } }),
        }
      },
    } as any
    await new GeminiProvider(client).estimate("two eggs")
    expect(seen[0].systemInstruction).toContain("protein_g")
  })
```

- [ ] **Step 8: Run the provider tests to see them fail**

Run: `bun test src/ai/providers`
Expected: the new tests FAIL (protein undefined; schema lacks protein_g; prompts lack the word).

- [ ] **Step 9: Update the three providers**

`src/ai/providers/openai.ts`:

```ts
// src/ai/providers/openai.ts
import OpenAI from "openai"
import { AIProvider, ProviderResult } from "../types"
import { config } from "../../config"
import { PROTEIN_RULE } from "../prompt"
import { normalizeItems } from "../parse"

const INSTRUCTIONS = `You are a nutrition expert that estimates calories and protein in food.

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include a relevant emoji for each food item
- If multiple items are mentioned, break them down separately
- If quantity or size is unclear, set needsClarification to true and ask a
  specific question in clarificationQuestion
- When no clarification is needed, return an empty string for
  clarificationQuestion
${PROTEIN_RULE}`

/**
 * Strict Structured Outputs requires every property to appear in `required`
 * and `additionalProperties: false` on every object. Fields that are
 * conceptually optional (clarificationQuestion, emoji) are therefore required
 * here and filled with an empty string when not applicable — see INSTRUCTIONS.
 */
const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          emoji: { type: "string" },
        },
        required: ["description", "calories", "protein_g", "emoji"],
        additionalProperties: false,
      },
    },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["items", "needsClarification", "clarificationQuestion", "confidence"],
  additionalProperties: false,
} as const
```

In `estimate`, change the parse/return block:

```ts
    const result = JSON.parse(content) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(result.items),
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion || undefined,
        confidence: result.confidence || "medium",
      },
      usage: { /* unchanged */ },
    }
```

(Leave the `usage` block exactly as it is today.)

`src/ai/providers/anthropic.ts`: delete the local `SYSTEM_PROMPT` constant and the `FoodEstimate` import; add imports and use the shared helpers:

```ts
import { AIProvider, ProviderResult } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT } from "../prompt"
import { normalizeItems, stripFences } from "../parse"
```

In `estimate`: `system: ESTIMATE_JSON_PROMPT,`; replace the fence-stripping lines and parse with:

```ts
    const result = JSON.parse(stripFences(content.text)) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }
```

and in the return: `items: normalizeItems(result.items),`.

`src/ai/providers/gemini.ts`: same treatment — delete `SYSTEM_PROMPT` and the `FoodEstimate` import, import `ESTIMATE_JSON_PROMPT`, `normalizeItems`, `stripFences`; `systemInstruction: ESTIMATE_JSON_PROMPT,`; `const parsed = JSON.parse(stripFences(content)) as { items: unknown; ... }`; `items: normalizeItems(parsed.items),`.

- [ ] **Step 10: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (7 parse + 3 OpenAI + 2 Anthropic + 2 Gemini new → 229 total), tsc clean.

- [ ] **Step 11: Commit**

```bash
git add src/ai/types.ts src/ai/parse.ts src/ai/parse.test.ts src/ai/prompt.ts src/ai/providers src/ai/service.test.ts src/db/repositories/cache.test.ts
git commit -m "feat(ai): ask providers for protein_g and normalize it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `estimateProtein` batch call on every provider

**Files:**
- Modify: `src/ai/types.ts`
- Modify: `src/ai/prompt.ts`
- Modify: `src/ai/parse.ts`, `src/ai/parse.test.ts`
- Modify: `src/ai/providers/openai.ts`, `anthropic.ts`, `gemini.ts` and their tests
- Modify: `src/ai/service.test.ts:31-39` (fake provider gains the method)

**Interfaces:**
- Produces:
  - `ProteinBatchResult { protein: (number | null)[]; usage: TokenUsage }` — `protein` aligned with the input array.
  - `AIProvider.estimateProtein(descriptions: string[]): Promise<ProteinBatchResult>` on all three providers.
  - `prompt.ts`: `PROTEIN_BATCH_PROMPT`, `formatProteinBatchInput(descriptions): string` (numbered lines, whitespace collapsed).
  - `parse.ts`: `alignProteinBatch(reply: unknown, count: number): (number | null)[]`.

- [ ] **Step 1: Add parse tests for alignment**

Append to `src/ai/parse.test.ts` (and add `alignProteinBatch` to the import):

```ts
describe("alignProteinBatch", () => {
  test("maps entries back onto inputs by 1-based index", () => {
    const reply = { items: [{ index: 2, protein_g: 4 }, { index: 1, protein_g: 28.2 }] }
    expect(alignProteinBatch(reply, 2)).toEqual([28, 4])
  })

  test("leaves missing, duplicate-free gaps and out-of-range indices as null", () => {
    const reply = { items: [{ index: 1, protein_g: 10 }, { index: 5, protein_g: 99 }, { index: "2", protein_g: 3 }] }
    expect(alignProteinBatch(reply, 3)).toEqual([10, null, null])
  })

  test("returns all nulls for garbage", () => {
    expect(alignProteinBatch(null, 2)).toEqual([null, null])
    expect(alignProteinBatch({ items: "x" }, 2)).toEqual([null, null])
  })
})
```

- [ ] **Step 2: Implement `alignProteinBatch` and the batch prompt**

Append to `src/ai/parse.ts`:

```ts
/**
 * Maps a batch reply `{items:[{index, protein_g}]}` back onto the inputs by
 * 1-based index. Anything missing, malformed or out of range stays null, which
 * the backfill reports as unresolved.
 */
export function alignProteinBatch(reply: unknown, count: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null)
  const items = (reply as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return out
  for (const entry of items) {
    const index = (entry as { index?: unknown } | null)?.index
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > count) continue
    out[index - 1] = coerceProtein((entry as { protein_g?: unknown }).protein_g)
  }
  return out
}
```

Append to `src/ai/prompt.ts`:

```ts
export const PROTEIN_BATCH_PROMPT = `You are a nutrition expert. You will receive a numbered list of food descriptions, one per line, in the form "1. <description>".

For each line, estimate the grams of protein, using common portion sizes when none is given.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"items":[{"index":1,"protein_g":14},{"index":2,"protein_g":0}]}

Rules:
- Return exactly one entry per input line, using that line's number as index
- protein_g is a whole number of grams
- Never skip a line; if unsure, give your best estimate`

/** "1. Chicken adobo\n2. Rice" — newlines inside a description are collapsed so lines stay lines. */
export function formatProteinBatchInput(descriptions: string[]): string {
  return descriptions.map((d, i) => `${i + 1}. ${d.replace(/\s+/g, " ").trim()}`).join("\n")
}
```

Run: `bun test src/ai/parse.test.ts` → 10 pass.

- [ ] **Step 3: Extend the types**

In `src/ai/types.ts`, add after `ProviderResult`:

```ts
export interface ProteinBatchResult {
  /** Aligned with the input array. null where the model gave nothing usable. */
  protein: (number | null)[]
  usage: TokenUsage
}
```

and change `AIProvider`:

```ts
export interface AIProvider {
  name: string
  estimate(foodDescription: string, context?: string): Promise<ProviderResult>
  /** Protein for many descriptions in one call; the caller chunks. */
  estimateProtein(descriptions: string[]): Promise<ProteinBatchResult>
}
```

Update the fake in `src/ai/service.test.ts`:

```ts
function fakeProvider(result: ProviderResult | Error): AIProvider {
  return {
    name: "openai",
    estimate: async () => {
      if (result instanceof Error) throw result
      return result
    },
    estimateProtein: async () => {
      throw new Error("not used in this test")
    },
  }
}
```

Run `bunx tsc --noEmit` — expect three errors: each provider class does not implement `estimateProtein`.

- [ ] **Step 4: Write provider tests for the batch call**

Append to `src/ai/providers/openai.test.ts`:

```ts
describe("OpenAIProvider.estimateProtein", () => {
  const BATCH_REPLY = JSON.stringify({ items: [{ index: 1, protein_g: 38 }, { index: 2, protein_g: 4 }] })

  test("numbers the descriptions, uses a strict schema, and aligns the reply", async () => {
    const { client, calls } = fakeClient(BATCH_REPLY)
    const result = await new OpenAIProvider(client).estimateProtein(["Chicken adobo", "Rice"])

    expect(calls[0].input).toBe("1. Chicken adobo\n2. Rice")
    expect(calls[0].store).toBe(false)
    expect(calls[0].text.format.strict).toBe(true)
    expect(calls[0].text.format.name).toBe("protein_batch")
    expect(result.protein).toEqual([38, 4])
    expect(result.usage.inputTokens).toBe(120)
  })

  test("leaves unanswered indices null", async () => {
    const { client } = fakeClient(JSON.stringify({ items: [{ index: 2, protein_g: 4 }] }))
    const result = await new OpenAIProvider(client).estimateProtein(["Mystery", "Rice"])
    expect(result.protein).toEqual([null, 4])
  })
})
```

Append to `src/ai/providers/anthropic.test.ts`:

```ts
describe("AnthropicProvider.estimateProtein", () => {
  test("sends the batch prompt and aligns the reply", async () => {
    const calls: any[] = []
    const client = {
      messages: {
        create: async (args: any) => {
          calls.push(args)
          return {
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: "```json\n" + JSON.stringify({ items: [{ index: 1, protein_g: 38 }] }) + "\n```" }],
            usage: { input_tokens: 90, output_tokens: 12 },
          }
        },
      },
    } as unknown as Anthropic
    const result = await new AnthropicProvider(client).estimateProtein(["Chicken adobo", "Rice"])

    expect(calls[0].system).toContain("numbered list")
    expect(calls[0].messages[0].content).toBe("1. Chicken adobo\n2. Rice")
    expect(result.protein).toEqual([38, null])
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 12 })
  })
})
```

Append to `src/ai/providers/gemini.test.ts`:

```ts
describe("GeminiProvider.estimateProtein", () => {
  test("sends the batch prompt and aligns the reply", async () => {
    const seen: { opts: any; input?: string } = { opts: null }
    const client = {
      getGenerativeModel: (opts: any) => {
        seen.opts = opts
        return {
          generateContent: async (input: string) => {
            seen.input = input
            return {
              response: {
                text: () => JSON.stringify({ items: [{ index: 1, protein_g: 38 }, { index: 2, protein_g: 4 }] }),
                usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 },
              },
            }
          },
        }
      },
    } as any
    const result = await new GeminiProvider(client).estimateProtein(["Chicken adobo", "Rice"])

    expect(seen.opts.systemInstruction).toContain("numbered list")
    expect(seen.input).toBe("1. Chicken adobo\n2. Rice")
    expect(result.protein).toEqual([38, 4])
    expect(result.usage).toMatchObject({ inputTokens: 80, outputTokens: 20 })
  })
})
```

- [ ] **Step 5: Implement `estimateProtein` in OpenAI**

In `src/ai/providers/openai.ts`, add imports:

```ts
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { PROTEIN_RULE, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, alignProteinBatch } from "../parse"
```

Add after `ESTIMATE_SCHEMA`:

```ts
const PROTEIN_BATCH_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          protein_g: { type: "number" },
        },
        required: ["index", "protein_g"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const

const MODEL = "gpt-5.6-luna"

/** The subset of a Responses API result that usage accounting reads. */
interface ResponsesUsageSource {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

function usageFrom(response: ResponsesUsageSource): TokenUsage {
  return {
    model: response.model ?? MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  }
}
```

In `estimate`, use `model: MODEL` and replace the inline `usage: { ... }` object with `usage: usageFrom(response),`. Then add the method:

```ts
  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const response = await this.client.responses.create({
      model: MODEL,
      instructions: PROTEIN_BATCH_PROMPT,
      input: formatProteinBatchInput(descriptions),
      reasoning: { effort: "none" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "protein_batch",
          schema: PROTEIN_BATCH_SCHEMA,
          strict: true,
        },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    return {
      protein: alignProteinBatch(JSON.parse(content), descriptions.length),
      usage: usageFrom(response),
    }
  }
```

- [ ] **Step 6: Implement `estimateProtein` in Anthropic**

In `src/ai/providers/anthropic.ts`, imports:

```ts
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, stripFences, alignProteinBatch } from "../parse"
```

Add module-level helpers above the class:

```ts
const MODEL = "claude-haiku-4-5-20251001"

interface AnthropicUsageSource {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }
}

function usageFrom(response: AnthropicUsageSource): TokenUsage {
  return {
    model: response.model ?? MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }
}

/** The first content block as text, or throws — the shape every call here expects. */
function firstText(response: { content: { type: string; text?: string }[] }): string {
  const block = response.content[0]
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("Unexpected response type from Anthropic")
  }
  return block.text
}
```

Rewrite `estimate` to use them (behavior unchanged):

```ts
  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: ESTIMATE_JSON_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })

    const result = JSON.parse(stripFences(firstText(response))) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(result.items),
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion,
        confidence: result.confidence || "medium",
      },
      usage: usageFrom(response),
    }
  }

  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: PROTEIN_BATCH_PROMPT,
      messages: [{ role: "user", content: formatProteinBatchInput(descriptions) }],
    })

    return {
      protein: alignProteinBatch(JSON.parse(stripFences(firstText(response))), descriptions.length),
      usage: usageFrom(response),
    }
  }
```

If `tsc` rejects passing the SDK's `Message` to `firstText` because its content union has blocks without `text`, widen the parameter to `{ content: Array<{ type: string } & Partial<{ text: string }>> }`.

- [ ] **Step 7: Implement `estimateProtein` in Gemini**

In `src/ai/providers/gemini.ts`, imports:

```ts
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, stripFences, alignProteinBatch } from "../parse"
```

Add `const MODEL = "gemini-3.1-flash-lite"` above the class, and inside the class a private helper plus the new method:

```ts
  private model(systemInstruction: string) {
    return this.client.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
      systemInstruction,
    })
  }

  private async generate(systemInstruction: string, input: string): Promise<{ text: string; usage: TokenUsage }> {
    const result = await this.model(systemInstruction).generateContent(input)
    const response = result.response
    const text = response.text()
    if (!text) {
      throw new Error("No response from Gemini")
    }
    // usageMetadata is nested under result.response, not on the result itself.
    const meta = response.usageMetadata
    return {
      text,
      usage: {
        model: MODEL,
        inputTokens: meta?.promptTokenCount ?? 0,
        cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
        outputTokens: meta?.candidatesTokenCount ?? 0,
      },
    }
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const { text, usage } = await this.generate(ESTIMATE_JSON_PROMPT, userMessage)
    const parsed = JSON.parse(stripFences(text)) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(parsed.items),
        needsClarification: parsed.needsClarification || false,
        clarificationQuestion: parsed.clarificationQuestion,
        confidence: parsed.confidence || "medium",
      },
      usage,
    }
  }

  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const { text, usage } = await this.generate(PROTEIN_BATCH_PROMPT, formatProteinBatchInput(descriptions))
    return {
      protein: alignProteinBatch(JSON.parse(stripFences(text)), descriptions.length),
      usage,
    }
  }
```

(Remove the old body of `estimate` that this replaces.)

- [ ] **Step 8: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (3 parse + 2 OpenAI + 1 Anthropic + 1 Gemini new → 236 total), tsc clean. The existing Gemini test "reports zero tokens when usageMetadata is absent" must still pass.

- [ ] **Step 9: Commit**

```bash
git add src/ai
git commit -m "feat(ai): estimateProtein batch call on every provider" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Protein-aware cache and `estimateProtein` in `AIService`

**Files:**
- Modify: `src/ai/service.ts`
- Modify: `src/ai/service.test.ts`

**Interfaces:**
- Produces:
  - `isCurrentShape(result: EstimationResult): boolean` (exported) — every item has finite `protein_g`.
  - `AIService.estimateProtein(descriptions: string[], providerName: string, opts: { telegramId: number; chatId: number | null }): Promise<(number | null)[]>` — never reads or writes the cache; records one `backfill` usage row.
  - Cache reads ignore results that fail `isCurrentShape`; cache writes skip them.

- [ ] **Step 1: Write the failing tests**

Append to `src/ai/service.test.ts`:

```ts
describe("protein-aware cache", () => {
  test("treats a cached result without protein_g as a miss and overwrites it", async () => {
    const stale = {
      items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high",
    } as unknown as EstimationResult
    cache.set("chicken adobo", stale)
    service = build(fakeProvider(OK_RESULT))

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result).toEqual(ESTIMATE)
    expect(usage.rows).toHaveLength(1)
    expect(cache.store.get("chicken adobo")).toEqual(ESTIMATE)
  })

  test("does not cache a result with unknown protein", async () => {
    const partial: EstimationResult = {
      ...ESTIMATE,
      items: [{ description: "Mystery", calories: 100, protein_g: null }],
    }
    service = build(fakeProvider({ ...OK_RESULT, estimate: partial }))

    await service.estimate("mystery", "openai", OPTS)

    expect(cache.store.size).toBe(0)
  })
})

describe("estimateProtein", () => {
  function batchProvider(protein: (number | null)[]): AIProvider {
    return {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => ({ protein, usage: OK_RESULT.usage }),
    }
  }

  test("returns the aligned protein array and records one backfill row", async () => {
    service = build(batchProvider([38, null]))

    const result = await service.estimateProtein(["Chicken adobo", "Mystery"], "openai", { telegramId: 7, chatId: null })

    expect(result).toEqual([38, null])
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ telegramId: 7, chatId: null, callType: "backfill", status: "ok" })
  })

  test("never touches the cache", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(batchProvider([1]))

    await service.estimateProtein(["Chicken adobo"], "openai", { telegramId: 7, chatId: null })

    expect(cache.store.size).toBe(1)
    expect(usage.rows).toHaveLength(1)
  })

  test("records parse_error on a SyntaxError and rethrows", async () => {
    const broken: AIProvider = {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => {
        throw new SyntaxError("Unexpected token")
      },
    }
    service = build(broken)

    await expect(service.estimateProtein(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()
    expect(usage.rows[0]).toMatchObject({ callType: "backfill", status: "parse_error" })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ai/service.test.ts`
Expected: FAIL — stale cache returned as a hit; `estimateProtein is not a function`.

- [ ] **Step 3: Implement**

Rewrite `src/ai/service.ts`:

```ts
// src/ai/service.ts
import { AIProvider, EstimationResult, ProteinBatchResult } from "./types"
import { OpenAIProvider } from "./providers/openai"
import { AnthropicProvider } from "./providers/anthropic"
import { GeminiProvider } from "./providers/gemini"
import { CacheRepository } from "../db/repositories/cache"
import { UsageRepository } from "../db/repositories/usage"
import { calculateCost } from "./pricing"
import type { CallType, UsageStatus, TokenUsage } from "./types"
import { config } from "../config"

export interface EstimateOptions {
  telegramId: number
  chatId: number | null
  callType: CallType
  context?: string
}

export interface ProteinOptions {
  telegramId: number
  chatId: number | null
}

/**
 * Cached results written before protein tracking have no protein_g. Treating
 * them as misses lets the cache heal itself one description at a time instead
 * of needing a wipe or a version key.
 */
export function isCurrentShape(result: EstimationResult): boolean {
  return result.items.every((item) => typeof item.protein_g === "number" && Number.isFinite(item.protein_g))
}

export class AIService {
  private providers: Map<string, AIProvider> = new Map()

  constructor(
    private cache: CacheRepository,
    private usage: UsageRepository
  ) {
    if (config.ai.openaiApiKey) {
      this.providers.set("openai", new OpenAIProvider())
    }
    if (config.ai.anthropicApiKey) {
      this.providers.set("anthropic", new AnthropicProvider())
    }
    if (config.ai.googleApiKey) {
      this.providers.set("gemini", new GeminiProvider())
    }
  }

  async estimate(
    foodDescription: string,
    providerName: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    const normalizedFood = this.normalizeFood(foodDescription)

    // Check cache first (only if no context and caching enabled)
    if (!opts.context && config.features.caching) {
      const cached = this.cache.get(normalizedFood)
      if (cached && isCurrentShape(cached)) return cached // nothing billed, nothing recorded
    }

    const provider = this.resolveProvider(providerName)
    return this.estimateWithProvider(provider, foodDescription, normalizedFood, opts)
  }

  /**
   * Protein for many descriptions in one billed call. No cache: the backfill
   * is the only caller and it only asks about rows that have no protein yet.
   */
  async estimateProtein(
    descriptions: string[],
    providerName: string,
    opts: ProteinOptions
  ): Promise<(number | null)[]> {
    const provider = this.resolveProvider(providerName)
    const recordOpts: EstimateOptions = { ...opts, callType: "backfill" }

    let result: ProteinBatchResult
    try {
      result = await provider.estimateProtein(descriptions)
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.recordSafely(provider.name, { model: "unknown", inputTokens: 0, outputTokens: 0 }, recordOpts, "parse_error")
      }
      throw error
    }

    this.recordSafely(provider.name, result.usage, recordOpts, this.statusFor(result.usage))
    return result.protein
  }

  private resolveProvider(providerName: string): AIProvider {
    const provider = this.providers.get(providerName) ?? this.providers.values().next().value
    if (!provider) {
      throw new Error("No AI provider configured")
    }
    return provider
  }

  private statusFor(usage: TokenUsage): UsageStatus {
    return usage.inputTokens === 0 && usage.outputTokens === 0 ? "no_usage" : "ok"
  }

  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    let result
    try {
      result = await provider.estimate(foodDescription, opts.context)
    } catch (error) {
      // A JSON parse failure means the API replied and billed us, but the body
      // was unusable. Any other error means no usable response at all, so there
      // is nothing to attribute.
      if (error instanceof SyntaxError) {
        this.recordSafely(
          provider.name,
          { model: "unknown", inputTokens: 0, outputTokens: 0 },
          opts,
          "parse_error"
        )
      }
      throw error
    }

    this.recordSafely(provider.name, result.usage, opts, this.statusFor(result.usage))

    const estimate = result.estimate
    // A result with unknown protein is not worth keeping: the next ask should
    // get another chance at a complete answer.
    if (!estimate.needsClarification && !opts.context && config.features.caching && isCurrentShape(estimate)) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }

  /** Accounting must never break calorie logging. */
  private recordSafely(
    providerName: string,
    usage: TokenUsage,
    opts: EstimateOptions,
    status: UsageStatus
  ): void {
    try {
      this.usage.record({
        telegramId: opts.telegramId,
        chatId: opts.chatId,
        provider: providerName,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens ?? null,
        costUsd: calculateCost(usage),
        callType: opts.callType,
        status,
      })
    } catch (error) {
      console.error("[usage] Failed to record AI usage:", error)
    }
  }

  private normalizeFood(food: string): string {
    return food
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }
}
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (5 new → 241 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/ai/service.ts src/ai/service.test.ts
git commit -m "feat(ai): protein-aware cache and estimateProtein in AIService" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Protein backfill job

**Files:**
- Create: `src/jobs/backfill-protein.ts`
- Create: `src/jobs/backfill-protein.test.ts`

**Interfaces:**
- Consumes: `FoodLogsRepository.listDescriptionsMissingProtein`, `setProteinForDescription` (Task 2); `AIService.estimateProtein` (Task 7).
- Produces:
  ```ts
  export interface BackfillReport { descriptions: number; calls: number; itemsFilled: number; unresolved: number }
  export interface BackfillOptions { providerName: string; telegramId: number; chatId: number | null; chunkSize?: number; pauseMs?: number }
  export const DEFAULT_CHUNK_SIZE = 25
  export function chunk<T>(items: T[], size: number): T[][]
  export async function runProteinBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/backfill-protein.test.ts`:

```ts
// src/jobs/backfill-protein.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { chunk, runProteinBackfill } from "./backfill-protein"

let foodLogsRepo: FoodLogsRepository

beforeEach(() => {
  foodLogsRepo = new FoodLogsRepository(createTestDb())
})

const OPTS = { providerName: "gemini", telegramId: 1, chatId: null, pauseMs: 0 }

describe("chunk", () => {
  test("splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe("runProteinBackfill", () => {
  test("fills only null rows, matching by exact description", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
      { description: "Eggs", calories: 180, protein_g: 12 },
    ])
    const estimateProtein = mock(async (descriptions: string[]) =>
      descriptions.map((d) => (d === "Rice" ? 4 : 38))
    )

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(estimateProtein).toHaveBeenCalledTimes(1)
    expect(estimateProtein).toHaveBeenCalledWith(["Chicken adobo", "Rice"], "gemini", { telegramId: 1, chatId: null })
    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 3, unresolved: 0 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25").map((i) => i.protein_g)).toEqual([38, 38, 4, 12])
  })

  test("counts null answers as unresolved and leaves those rows null", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Mystery", calories: 100 },
      { description: "Rice", calories: 200 },
    ])
    const estimateProtein = mock(async (descriptions: string[]) => descriptions.map((d) => (d === "Mystery" ? null : 4)))

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.listDescriptionsMissingProtein()).toEqual(["Mystery"])
  })

  test("chunks by chunkSize and keeps going when one chunk throws", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "A", calories: 1 },
      { description: "B", calories: 1 },
      { description: "C", calories: 1 },
      { description: "D", calories: 1 },
      { description: "E", calories: 1 },
    ])
    let call = 0
    const estimateProtein = mock(async (descriptions: string[]) => {
      call++
      if (call === 2) throw new Error("503")
      return descriptions.map(() => 10)
    })

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, { ...OPTS, chunkSize: 2 })

    expect(estimateProtein).toHaveBeenCalledTimes(3)
    expect(report).toEqual({ descriptions: 5, calls: 3, itemsFilled: 3, unresolved: 2 })
    expect(foodLogsRepo.listDescriptionsMissingProtein()).toEqual(["C", "D"])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("makes no calls when nothing is missing", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    const estimateProtein = mock(async () => [])

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(estimateProtein).not.toHaveBeenCalled()
    expect(report).toEqual({ descriptions: 0, calls: 0, itemsFilled: 0, unresolved: 0 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/jobs/backfill-protein.test.ts`
Expected: FAIL — `Cannot find module './backfill-protein'`.

- [ ] **Step 3: Implement the job**

Create `src/jobs/backfill-protein.ts`:

```ts
// src/jobs/backfill-protein.ts
// Fills protein_g for items logged before protein tracking existed. Sends many
// descriptions per AI call so the system prompt is paid for once per chunk,
// which is where the cost is; a provider batch API would save a similar
// amount at the price of async job tracking (see the spec's Decisions table).
import type { FoodLogsRepository } from "../db/repositories/food-logs"
import type { AIService } from "../ai/service"

export interface BackfillReport {
  /** Distinct descriptions that were missing protein when the run started. */
  descriptions: number
  /** Chunks attempted, including ones that threw. */
  calls: number
  /** food_items rows updated. */
  itemsFilled: number
  /** Descriptions still without protein after the run. */
  unresolved: number
}

export interface BackfillOptions {
  providerName: string
  telegramId: number
  chatId: number | null
  chunkSize?: number
  /** Pause between chunks. Tests pass 0. */
  pauseMs?: number
}

export interface BackfillDeps {
  foodLogsRepo: Pick<FoodLogsRepository, "listDescriptionsMissingProtein" | "setProteinForDescription">
  aiService: Pick<AIService, "estimateProtein">
}

export const DEFAULT_CHUNK_SIZE = 25
export const DEFAULT_PAUSE_MS = 500

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Only null rows are ever written, so running this twice is safe and a
 * partial failure is retried simply by running it again.
 */
export async function runProteinBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const descriptions = deps.foodLogsRepo.listDescriptionsMissingProtein()
  const chunks = chunk(descriptions, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS
  const report: BackfillReport = { descriptions: descriptions.length, calls: 0, itemsFilled: 0, unresolved: 0 }

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]
    report.calls++

    let protein: (number | null)[]
    try {
      protein = await deps.aiService.estimateProtein(batch, opts.providerName, {
        telegramId: opts.telegramId,
        chatId: opts.chatId,
      })
    } catch (error) {
      console.error(`[backfill] chunk ${i + 1}/${chunks.length} failed:`, error)
      report.unresolved += batch.length
      continue
    }

    batch.forEach((description, j) => {
      const grams = protein[j]
      if (grams === null || grams === undefined) {
        report.unresolved++
        return
      }
      report.itemsFilled += deps.foodLogsRepo.setProteinForDescription(description, grams)
    })

    if (pauseMs > 0 && i < chunks.length - 1) {
      await Bun.sleep(pauseMs)
    }
  }

  return report
}
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (5 new → 246 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/backfill-protein.ts src/jobs/backfill-protein.test.ts
git commit -m "feat(jobs): protein backfill job" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `/admin backfill-protein`

**Files:**
- Modify: `src/bot/commands/admin.ts`
- Modify: `src/bot/index.ts:72`
- Create: `src/bot/commands/admin-backfill.test.ts`

**Interfaces:**
- Consumes: `runProteinBackfill`, `DEFAULT_CHUNK_SIZE` (Task 8); `FoodLogsRepository.countItemsMissingProtein`, `listDescriptionsMissingProtein` (Task 2); `AIService.getAvailableProviders`.
- Produces:
  - `createAdminCommand(repo, usageRepo, deps: AdminDeps)` where `AdminDeps = { foodLogsRepo: FoodLogsRepository; usersRepo: UsersRepository; aiService: AIService }`.
  - `backfillProtein(deps: AdminDeps, adminId: number, chatId: number | null, reply: (text: string) => Promise<void>): Promise<void>` — exported so it can be tested without the admin gate (which reads `config.adminUsers` from the environment).

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/admin-backfill.test.ts`:

```ts
// src/bot/commands/admin-backfill.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import { backfillProtein } from "./admin"

const ADMIN = 7

let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let replies: string[]
const reply = async (text: string) => {
  replies.push(text)
}

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(ADMIN, "admin")
  replies = []
})

function fakeAi(protein: (descriptions: string[]) => (number | null)[], providers = ["gemini"]) {
  return {
    estimateProtein: mock(async (descriptions: string[]) => protein(descriptions)),
    getAvailableProviders: () => providers,
    hasProvider: (name: string) => providers.includes(name),
  } as unknown as AIService
}

describe("backfillProtein", () => {
  test("reports the plan, runs, and reports the result", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
    ])
    const aiService = fakeAi(() => [38, 4])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual([
      "Backfilling protein for 3 items across 2 descriptions (1 AI calls)…",
      "Done. Filled 3 items.",
    ])
  })

  test("mentions unresolved descriptions and how to retry", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Mystery", calories: 100 }, { description: "Rice", calories: 200 }])
    const aiService = fakeAi((d) => d.map((x) => (x === "Mystery" ? null : 4)))

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[1]).toBe("Done. Filled 1 items. 1 descriptions unresolved — run again to retry.")
  })

  test("says so when nothing is missing", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    const aiService = fakeAi(() => [])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["Nothing to backfill — every item has protein."])
    expect((aiService.estimateProtein as ReturnType<typeof mock>).mock.calls).toHaveLength(0)
  })

  test("refuses when no provider is configured", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [], [])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["No AI provider configured."])
  })

  test("uses the admin's provider and attributes usage to the admin", async () => {
    usersRepo.updateSettings(ADMIN, { ai_provider: "anthropic" })
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [4], ["gemini", "anthropic"])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 99, reply)

    expect(aiService.estimateProtein).toHaveBeenCalledWith(["Rice"], "anthropic", { telegramId: ADMIN, chatId: 99 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/bot/commands/admin-backfill.test.ts`
Expected: FAIL — `backfillProtein` is not exported.

- [ ] **Step 3: Implement**

In `src/bot/commands/admin.ts`, add imports:

```ts
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"
import { runProteinBackfill, DEFAULT_CHUNK_SIZE } from "../../jobs/backfill-protein"
```

Add before `createAdminCommand`:

```ts
export interface AdminDeps {
  foodLogsRepo: FoodLogsRepository
  usersRepo: UsersRepository
  aiService: AIService
}

/**
 * /admin backfill-protein. Separated from the command so it can be tested
 * without the admin gate, which reads config.adminUsers from the environment.
 * Usage rows are attributed to the admin who ran it.
 */
export async function backfillProtein(
  deps: AdminDeps,
  adminId: number,
  chatId: number | null,
  reply: (text: string) => Promise<void>
): Promise<void> {
  const descriptions = deps.foodLogsRepo.listDescriptionsMissingProtein()
  if (descriptions.length === 0) {
    await reply("Nothing to backfill — every item has protein.")
    return
  }
  if (deps.aiService.getAvailableProviders().length === 0) {
    await reply("No AI provider configured.")
    return
  }

  const items = deps.foodLogsRepo.countItemsMissingProtein()
  const calls = Math.ceil(descriptions.length / DEFAULT_CHUNK_SIZE)
  await reply(`Backfilling protein for ${items} items across ${descriptions.length} descriptions (${calls} AI calls)…`)

  // AIService falls back to the first configured provider if this one is not available.
  const providerName = deps.usersRepo.findById(adminId)?.ai_provider ?? "gemini"
  const report = await runProteinBackfill(
    { foodLogsRepo: deps.foodLogsRepo, aiService: deps.aiService },
    { providerName, telegramId: adminId, chatId }
  )

  let done = `Done. Filled ${report.itemsFilled} items.`
  if (report.unresolved > 0) {
    done += ` ${report.unresolved} descriptions unresolved — run again to retry.`
  }
  await reply(done)
}
```

Change the signature and help text:

```ts
export function createAdminCommand(repo: AllowedUsersRepository, usageRepo: UsageRepository, deps: AdminDeps) {
```

```ts
          "/admin usage [7d|30d|all]\n" +
          "/admin backfill-protein"
```

Add a case before `default:`:

```ts
      case "backfill-protein": {
        await backfillProtein(deps, userId, ctx.chat?.id ?? null, (text) => smartReply(ctx, text))
        break
      }
```

In `src/bot/index.ts` line 72:

```ts
  bot.command("admin", createAdminCommand(allowedUsersRepo, usageRepo, { foodLogsRepo, usersRepo, aiService }))
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (5 new → 251 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/admin.ts src/bot/commands/admin-backfill.test.ts src/bot/index.ts
git commit -m "feat(admin): /admin backfill-protein" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Protein in the `/log` confirmation and logged reply

**Files:**
- Modify: `src/bot/conversations/log-flow.ts:13-19, 236-242, 327-343`
- Modify: `src/bot/commands/log.ts:141-151`
- Modify: `src/bot/commands/log.test.ts:32-43`

**Interfaces:**
- Consumes: `sumTotals`, `formatTotals` (Task 4); `formatDateForDisplay`.
- Produces: `LogFlowResult.confirm?: { token: string; totals: { calories: number; protein: number } }`; `buildLogConfirmKeyboard(ownerId, confirm)` reads `confirm.totals`.

- [ ] **Step 1: Update the keyboard test**

In `src/bot/commands/log.test.ts`, replace the `buildLogConfirmKeyboard` test:

```ts
describe("buildLogConfirmKeyboard", () => {
  test("puts Log full-width above Change and Cancel, with both totals on the button", () => {
    const keyboard = buildLogConfirmKeyboard(42, { token: "abcd1234", totals: { calories: 335, protein: 28 } })
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "✅ Log 335 cal · 28 g", callback_data: "log:ok:42:abcd1234" }],
      [
        { text: "✏️ Change", callback_data: "log:chg:42:abcd1234" },
        { text: "✖️ Cancel", callback_data: "log:cxl:42:abcd1234" },
      ],
    ])
  })
})
```

Run: `bun test src/bot/commands/log.test.ts` → the keyboard test FAILS (type error / wrong label).

- [ ] **Step 2: Implement**

`src/bot/conversations/log-flow.ts`:

Import line 10 becomes:

```ts
import { formatItemsSummary, formatTotals, sumTotals, shortHash } from "../../utils/format"
```

Line 18:

```ts
  confirm?: { token: string; totals: { calories: number; protein: number } }
```

Lines 238-242 (typed "yes" path):

```ts
      return {
        message: `Logged ${formatTotals(sumTotals(items))} for ${formatDateForDisplay(state.target_date)}.`,
        action: "done",
      }
```

(Delete the `const totalCalories = ...` line above it.)

In `confirmationResult`:

```ts
      confirm: {
        token: confirmToken(targetDate, pendingItems),
        totals: sumTotals(items),
      },
```

`src/bot/commands/log.ts`:

```ts
export function buildLogConfirmKeyboard(
  ownerId: number,
  confirm: { token: string; totals: { calories: number; protein: number } }
): InlineKeyboard {
  const data = (action: LogAction) => encodeLogCallback({ action, ownerId, token: confirm.token })
  return new InlineKeyboard()
    .text(`✅ Log ${confirm.totals.calories} cal · ${confirm.totals.protein} g`, data("ok"))
    .row()
    .text("✏️ Change", data("chg"))
    .text("✖️ Cancel", data("cxl"))
}
```

- [ ] **Step 3: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 251 pass, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add src/bot/conversations/log-flow.ts src/bot/commands/log.ts src/bot/commands/log.test.ts
git commit -m "feat(log): protein in the confirmation card and logged reply" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `/today` with protein and mirrored goal blocks

**Files:**
- Modify: `src/bot/commands/today.ts`
- Create: `src/bot/commands/today.test.ts`

**Interfaces:**
- Consumes: `FoodLogsRepository.getTotals` (Task 2), `User.daily_protein_goal` (Task 3), `formatItemLine`, `formatGoalProgress` (Task 4).
- Produces: `buildTodayMessage(opts: { date: string; items: FoodItem[]; totals: DayTotals; dailyGoal: number | null | undefined; proteinGoal: number | null | undefined }): string` (exported, pure).

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/today.test.ts`:

```ts
// src/bot/commands/today.test.ts
import { describe, test, expect } from "bun:test"
import { buildTodayMessage } from "./today"

const items = [
  { id: 1, description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
  { id: 2, description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
]

describe("buildTodayMessage", () => {
  test("lists items with protein and shows both goal blocks", () => {
    expect(
      buildTodayMessage({
        date: "2026-09-25",
        items,
        totals: { calories: 1450, protein: 82 },
        dailyGoal: 2000,
        proteinGoal: 120,
      })
    ).toBe(
      "📅 Fri, Sep 25\n\n" +
        "1. 🍳 2 scrambled eggs — 180 cal · 14 g\n" +
        "2. 🍞 Toast — 150 cal · ? g\n\n" +
        "📊 Calories: 1,450 / 2,000 cal\n███████░░░ 73%\n✨ 550 cal remaining\n\n" +
        "💪 Protein: 82 / 120 g\n███████░░░ 68%\n✨ 38 g remaining"
    )
  })

  test("collapses a block to one line when that goal is not set", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { calories: 330, protein: 14 },
      dailyGoal: 2000,
      proteinGoal: null,
    })
    expect(out).toContain("📊 Calories: 330 / 2,000 cal\n")
    expect(out.endsWith("\n\n💪 Protein: 14 g")).toBe(true)
  })

  test("shows plain totals with no goals at all", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { calories: 330, protein: 14 },
      dailyGoal: undefined,
      proteinGoal: undefined,
    })
    expect(out.endsWith("📊 Calories: 330 cal\n\n💪 Protein: 14 g")).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/bot/commands/today.test.ts`
Expected: FAIL — `buildTodayMessage` is not exported.

- [ ] **Step 3: Implement**

Rewrite `src/bot/commands/today.ts`:

```ts
// src/bot/commands/today.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem, DayTotals } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { formatItemLine, formatGoalProgress } from "../../utils/format"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

/**
 * The /today body: numbered item lines, then a calorie block and a protein
 * block of the same shape. Pure, so the layout is testable without a bot.
 */
export function buildTodayMessage(opts: {
  date: string
  items: FoodItem[]
  totals: DayTotals
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
}): string {
  let message = `📅 ${formatDateForDisplay(opts.date)}\n\n`
  opts.items.forEach((item, i) => {
    message += `${i + 1}. ${formatItemLine(item)}\n`
  })
  message += "\n"
  message += formatGoalProgress({ emoji: "📊", label: "Calories", current: opts.totals.calories, goal: opts.dailyGoal, unit: "cal" })
  message += "\n\n"
  message += formatGoalProgress({ emoji: "💪", label: "Protein", current: opts.totals.protein, goal: opts.proteinGoal, unit: "g" })
  return message
}

export function createTodayCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const isPrivateChat = ctx.chat?.type === "private"
    const user = usersRepo.findById(userId)
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE
    const today = getTodayInTimezone(timezone)
    const entries = foodLogsRepo.getByDate(userId, today)

    let message: string
    if (entries.length === 0) {
      message =
        `📅 ${formatDateForDisplay(today)}\n\n` +
        "No food logged yet today.\n\n" +
        "Use /log to add your first entry!"
    } else {
      message = buildTodayMessage({
        date: today,
        items: entries.flatMap((log) => log.items),
        totals: foodLogsRepo.getTotals(userId, today),
        dailyGoal: user?.daily_goal,
        proteinGoal: user?.daily_protein_goal,
      })
    }

    // Add note for group chats
    if (!isPrivateChat) {
      message += "\n\n💬 Start a chat with me to see interactive charts!"
    }

    await smartReply(ctx, message, isPrivateChat ? {
      reply_markup: {
        inline_keyboard: [[
          { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
        ]]
      }
    } : {})

    // Try to DM the mini-app button in group chats
    if (!isPrivateChat) {
      try {
        await ctx.api.sendMessage(userId, "📈 Here's your chart view:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
            ]]
          }
        })
      } catch {
        // User hasn't started bot - the group note guides them
      }
    }
  }
}
```

(The local `createProgressBar` is gone; the shared one in `format.ts` is used via `formatGoalProgress`. The empty-day and populated-day branches now share one reply path, which is a behavior-preserving simplification.)

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (3 new → 254 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/today.ts src/bot/commands/today.test.ts
git commit -m "feat(today): protein line and mirrored goal blocks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Protein in `/week` and `/month`

**Files:**
- Modify: `src/bot/commands/stats.ts`
- Create: `src/bot/commands/stats.test.ts`

**Interfaces:**
- Consumes: `DayTotals`, `getDailyTotals` (Task 2); `User.daily_protein_goal` (Task 3); `formatTotals` (Task 4).
- Produces: `buildStatsMessage(opts: { period: string; days: number; dateRange: string[]; dailyTotals: Record<string, DayTotals>; dailyGoal: number | null | undefined; proteinGoal: number | null | undefined }): string` (exported, pure; handles the empty case too).

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/stats.test.ts`:

```ts
// src/bot/commands/stats.test.ts
import { describe, test, expect } from "bun:test"
import { buildStatsMessage } from "./stats"

// Mon 2026-09-21 .. Sun 2026-09-27
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]

describe("buildStatsMessage (week)", () => {
  const dailyTotals = {
    "2026-09-21": { calories: 1450, protein: 82 },
    "2026-09-22": { calories: 2100, protein: 130 },
    "2026-09-25": { calories: 1800, protein: 100 },
  }

  test("renders daily rows with protein, both totals, and both goal lines", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals, dailyGoal: 2000, proteinGoal: 120 })

    expect(out).toContain("📊 Week Summary\nMon, Sep 21 - Sun, Sep 27\n\n")
    expect(out).toContain("Mon: ████░ 1,450 cal · 82 g\n")
    expect(out).toContain("Tue: █████ 2,100 cal · 130 g\n")
    expect(out).toContain("Wed: ░░░░░ —\n")
    expect(out).toContain("\n📈 Total: 5,350 cal · 312 g protein\n")
    expect(out).toContain("📊 Daily avg: 1,783 cal · 104 g protein\n")
    expect(out).toContain("📅 Days tracked: 3/7")
    expect(out).toContain("\n🎯 Under calorie goal: 2/3 days (67%)")
    expect(out).toContain("\n💪 Protein goal met: 1/3 days (33%)")
  })

  test("counts protein at the goal as met", () => {
    const out = buildStatsMessage({
      period: "Week",
      days: 7,
      dateRange: WEEK,
      dailyTotals: { "2026-09-21": { calories: 1000, protein: 120 } },
      dailyGoal: null,
      proteinGoal: 120,
    })
    expect(out).toContain("💪 Protein goal met: 1/1 days (100%)")
    expect(out).not.toContain("Under calorie goal")
  })

  test("omits goal lines when no goals are set", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals, dailyGoal: undefined, proteinGoal: undefined })
    expect(out).not.toContain("goal")
  })

  test("says so when nothing was logged", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals: {}, dailyGoal: 2000, proteinGoal: 120 })
    expect(out).toBe("📊 Week Summary\nMon, Sep 21 - Sun, Sep 27\n\nNo data logged for this period.\n\nUse /log to start tracking!")
  })
})

describe("buildStatsMessage (month)", () => {
  test("renders weekly rows with both units and per-day averages", () => {
    const dateRange: string[] = []
    for (let d = 1; d <= 30; d++) dateRange.push(`2026-09-${String(d).padStart(2, "0")}`)
    const dailyTotals: Record<string, { calories: number; protein: number }> = {
      "2026-09-01": { calories: 9800, protein: 520 }, // all of week 1 on one day
      "2026-09-10": { calories: 1400, protein: 70 },
    }

    const out = buildStatsMessage({ period: "Month", days: 30, dateRange, dailyTotals, dailyGoal: null, proteinGoal: null })

    expect(out).toContain("Week 1: 9,800 cal · 520 g protein (avg 1,400 cal · 74 g/day)\n")
    expect(out).toContain("Week 2: 1,400 cal · 70 g protein (avg 200 cal · 10 g/day)\n")
    expect(out).toContain("Week 3: 0 cal · 0 g protein (avg 0 cal · 0 g/day)\n")
    expect(out).toContain("📅 Days tracked: 2/30")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/bot/commands/stats.test.ts`
Expected: FAIL — `buildStatsMessage` is not exported.

- [ ] **Step 3: Implement**

Rewrite `src/bot/commands/stats.ts`:

```ts
// src/bot/commands/stats.ts
import { Context } from "grammy"
import { FoodLogsRepository, DayTotals } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getDateRangeInTimezone, formatDateForDisplay, getDayOfWeek, DEFAULT_TIMEZONE } from "../../utils/dates"
import { formatTotals } from "../../utils/format"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

const n = (value: number) => value.toLocaleString("en-US")

export function createWeekCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    await sendStatsMessage(ctx, userId, 7, "Week", foodLogsRepo, usersRepo)
  }
}

export function createMonthCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    await sendStatsMessage(ctx, userId, 30, "Month", foodLogsRepo, usersRepo)
  }
}

/**
 * The /week and /month body. Calories are a ceiling and protein a floor, so the
 * goal lines read "Under calorie goal" and "Protein goal met" (at or above).
 */
export function buildStatsMessage(opts: {
  period: string
  days: number
  dateRange: string[]
  dailyTotals: Record<string, DayTotals>
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
}): string {
  const { period, days, dateRange, dailyTotals, dailyGoal, proteinGoal } = opts
  const startDate = dateRange[0]
  const endDate = dateRange[dateRange.length - 1]
  const loggedDays = Object.values(dailyTotals)
  const daysWithData = loggedDays.length

  let message = `📊 ${period} Summary\n`
  message += `${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}\n\n`

  if (daysWithData === 0) {
    message += "No data logged for this period.\n\n"
    message += "Use /log to start tracking!"
    return message
  }

  const total = loggedDays.reduce(
    (acc, d) => ({ calories: acc.calories + d.calories, protein: acc.protein + d.protein }),
    { calories: 0, protein: 0 }
  )
  const avg = {
    calories: Math.round(total.calories / daysWithData),
    protein: Math.round(total.protein / daysWithData),
  }

  if (days <= 7) {
    for (const date of dateRange) {
      const day = dailyTotals[date]
      const dayName = getDayOfWeek(date).slice(0, 3)
      if (day && day.calories > 0) {
        const bar = createMiniBar(day.calories, dailyGoal || avg.calories * 1.2)
        message += `${dayName}: ${bar} ${n(day.calories)} cal · ${n(day.protein)} g\n`
      } else {
        message += `${dayName}: ░░░░░ —\n`
      }
    }
  } else {
    const weeks = splitIntoWeeks(dateRange, dailyTotals)
    weeks.forEach((week, i) => {
      message +=
        `Week ${i + 1}: ${formatTotals(week)} ` +
        `(avg ${n(Math.round(week.calories / 7))} cal · ${n(Math.round(week.protein / 7))} g/day)\n`
    })
  }

  message += "\n"
  message += `📈 Total: ${formatTotals(total)}\n`
  message += `📊 Daily avg: ${formatTotals(avg)}\n`
  message += `📅 Days tracked: ${daysWithData}/${days}`

  if (dailyGoal) {
    const under = loggedDays.filter((d) => d.calories <= dailyGoal).length
    message += `\n🎯 Under calorie goal: ${under}/${daysWithData} days (${Math.round((under / daysWithData) * 100)}%)`
  }
  if (proteinGoal) {
    const met = loggedDays.filter((d) => d.protein >= proteinGoal).length
    message += `\n💪 Protein goal met: ${met}/${daysWithData} days (${Math.round((met / daysWithData) * 100)}%)`
  }

  return message
}

async function sendStatsMessage(
  ctx: Context,
  userId: number,
  days: number,
  period: string,
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  const isPrivateChat = ctx.chat?.type === "private"
  const user = usersRepo.findById(userId)
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE
  const today = getTodayInTimezone(timezone)
  const dateRange = getDateRangeInTimezone(days, today, timezone)

  let message = buildStatsMessage({
    period,
    days,
    dateRange,
    dailyTotals: foodLogsRepo.getDailyTotals(userId, dateRange[0], dateRange[dateRange.length - 1]),
    dailyGoal: user?.daily_goal,
    proteinGoal: user?.daily_protein_goal,
  })

  // Add note for group chats
  if (!isPrivateChat) {
    message += "\n\n💬 Start a chat with me to see interactive charts!"
  }

  await smartReply(ctx, message, isPrivateChat ? {
    reply_markup: {
      inline_keyboard: [[
        { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
      ]]
    }
  } : {})

  // Try to DM the mini-app button in group chats
  if (!isPrivateChat) {
    try {
      await ctx.api.sendMessage(userId, "📈 Here's your chart view:", {
        reply_markup: {
          inline_keyboard: [[
            { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
          ]]
        }
      })
    } catch {
      // User hasn't started bot - the group note guides them
    }
  }
}

function createMiniBar(value: number, max: number): string {
  const percentage = Math.min(value / max, 1)
  const filled = Math.round(percentage * 5)
  const empty = 5 - filled
  return "█".repeat(filled) + "░".repeat(empty)
}

function splitIntoWeeks(dateRange: string[], dailyTotals: Record<string, DayTotals>): DayTotals[] {
  const weeks: DayTotals[] = []
  let week: DayTotals = { calories: 0, protein: 0 }

  for (let i = 0; i < dateRange.length; i++) {
    const day = dailyTotals[dateRange[i]]
    if (day) {
      week = { calories: week.calories + day.calories, protein: week.protein + day.protein }
    }
    if ((i + 1) % 7 === 0) {
      weeks.push(week)
      week = { calories: 0, protein: 0 }
    }
  }

  // Add remaining days
  if (week.calories > 0 || dateRange.length % 7 !== 0) {
    weeks.push(week)
  }

  return weeks
}
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (5 new → 259 total), tsc clean. If the mini-bar assertion (`████░`) is off by one block, the test's expectation is wrong, not the bar: `createMiniBar(1450, 2000)` = round(0.725 × 5) = 4 blocks; `createMiniBar(2100, 2000)` = 5. Keep the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/stats.ts src/bot/commands/stats.test.ts
git commit -m "feat(stats): protein in /week and /month" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Daily protein goal in `/settings`

**Files:**
- Modify: `src/bot/commands/settings.ts`
- Create: `src/bot/commands/settings.test.ts`

**Interfaces:**
- Consumes: `UsersRepository.updateSettings({ daily_protein_goal })` (Task 3).
- Produces: exported `createMainKeyboard()` and `formatSettings(user)`; `pendingSettings` accepts `"protein"`; callback `settings:protein`.

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/settings.test.ts`:

```ts
// src/bot/commands/settings.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import {
  createMainKeyboard,
  formatSettings,
  createSettingsCallbackHandler,
  createSettingsMessageHandler,
  hasPendingSettings,
  clearPendingSettings,
} from "./settings"

const USER = 42
let usersRepo: UsersRepository
const aiService = { getAvailableProviders: () => ["gemini"], hasProvider: () => true } as unknown as AIService

beforeEach(() => {
  usersRepo = new UsersRepository(createTestDb())
  usersRepo.upsert(USER, "maria")
  clearPendingSettings(USER)
})

function callbackCtx(data: string) {
  return {
    from: { id: USER, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    deleteMessage: mock(() => Promise.resolve(true)),
  }
}

function messageCtx(text: string) {
  return {
    from: { id: USER, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    message: { text },
    reply: mock(() => Promise.resolve()),
  }
}

async function pressThenType(button: string, text: string) {
  await createSettingsCallbackHandler(usersRepo, aiService)(callbackCtx(button) as unknown as Context)
  const ctx = messageCtx(text)
  await createSettingsMessageHandler(usersRepo)(ctx as unknown as Context)
  return ctx
}

describe("createMainKeyboard", () => {
  test("offers calorie and protein goals on separate buttons", () => {
    const rows = createMainKeyboard().inline_keyboard.map((row) => row.map((b) => b.text))
    expect(rows).toEqual([
      ["Change Provider", "Set Calorie Goal"],
      ["Set Protein Goal", "Set Reminder"],
      ["Set Timezone", "Close"],
    ])
  })
})

describe("formatSettings", () => {
  test("shows both goals", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 120 })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Calorie Goal: 2,000 cal\nProtein Goal: 120 g\n")
  })

  test("shows Not set for missing goals", () => {
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Calorie Goal: Not set\nProtein Goal: Not set\n")
  })
})

describe("protein goal flow", () => {
  test("the button prompts for grams and arms the typed step", async () => {
    const ctx = callbackCtx("settings:protein")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      "⚙️ Set Protein Goal\n\nEnter your daily protein goal in grams (e.g., 120), or 'off' to clear it."
    )
    expect(hasPendingSettings(USER)).toBe(true)
  })

  test("a whole number sets the goal", async () => {
    const ctx = await pressThenType("settings:protein", "120")

    expect(usersRepo.findById(USER)!.daily_protein_goal).toBe(120)
    expect(ctx.reply).toHaveBeenCalledWith("Daily protein goal set to 120 g. Use /settings to view settings.", undefined)
    expect(hasPendingSettings(USER)).toBe(false)
  })

  test("off clears the goal", async () => {
    usersRepo.updateSettings(USER, { daily_protein_goal: 120 })
    const ctx = await pressThenType("settings:protein", "off")

    expect(usersRepo.findById(USER)!.daily_protein_goal).toBeNull()
    expect(ctx.reply).toHaveBeenCalledWith("Protein goal cleared. Use /settings to view settings.", undefined)
  })

  test("rejects values outside 10-500 and stays armed", async () => {
    const ctx = await pressThenType("settings:protein", "5")

    expect(ctx.reply).toHaveBeenCalledWith("Please enter a number between 10 and 500, or 'off' to clear.", undefined)
    expect(usersRepo.findById(USER)!.daily_protein_goal).toBeNull()
    expect(hasPendingSettings(USER)).toBe(true)
  })

  test("the calorie goal flow is unchanged", async () => {
    const ctx = await pressThenType("settings:goal", "1800")

    expect(usersRepo.findById(USER)!.daily_goal).toBe(1800)
    expect(ctx.reply).toHaveBeenCalledWith("Daily goal set to 1,800 cal. Use /settings to view settings.", undefined)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/bot/commands/settings.test.ts`
Expected: FAIL — `createMainKeyboard`/`formatSettings` not exported.

- [ ] **Step 3: Implement**

In `src/bot/commands/settings.ts`:

Line 9:

```ts
const pendingSettings = new Map<number, "goal" | "protein" | "reminder" | "timezone">()
```

Replace `createMainKeyboard`:

```ts
export function createMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Change Provider", "settings:provider")
    .text("Set Calorie Goal", "settings:goal")
    .row()
    .text("Set Protein Goal", "settings:protein")
    .text("Set Reminder", "settings:reminder")
    .row()
    .text("Set Timezone", "settings:timezone")
    .text("Close", "settings:close")
}
```

Replace `formatSettings`:

```ts
export function formatSettings(user: {
  ai_provider: string
  daily_goal: number | null
  daily_protein_goal: number | null
  reminder_time: string | null
  reminder_mention: boolean
  timezone: string
}): string {
  const provider = user.ai_provider.charAt(0).toUpperCase() + user.ai_provider.slice(1)
  const goal = user.daily_goal ? `${user.daily_goal.toLocaleString("en-US")} cal` : "Not set"
  const proteinGoal = user.daily_protein_goal ? `${user.daily_protein_goal} g` : "Not set"
  const reminder = user.reminder_time
    ? `${user.reminder_time} (mention: ${user.reminder_mention ? "on" : "off"})`
    : "Off"
  const timezone = user.timezone ?? DEFAULT_TIMEZONE

  return (
    `⚙️ Your Settings\n\n` +
    `AI Provider: ${provider}\n` +
    `Calorie Goal: ${goal}\n` +
    `Protein Goal: ${proteinGoal}\n` +
    `Reminder: ${reminder}\n` +
    `Timezone: ${timezone}`
  )
}
```

In the callback handler, rename the goal prompt header and add a case after `case "goal"`:

```ts
      case "goal": {
        pendingSettings.set(userId, "goal")
        await ctx.editMessageText(
          "⚙️ Set Calorie Goal\n\n" +
            "Enter your daily calorie goal (e.g., 2000), or 'off' to clear it."
        )
        await ctx.answerCallbackQuery()
        break
      }

      case "protein": {
        pendingSettings.set(userId, "protein")
        await ctx.editMessageText(
          "⚙️ Set Protein Goal\n\n" +
            "Enter your daily protein goal in grams (e.g., 120), or 'off' to clear it."
        )
        await ctx.answerCallbackQuery()
        break
      }
```

Also pin the locale on the existing calorie confirmation so the test is deterministic: in the `pending === "goal"` branch change `${goal.toLocaleString()} cal` to `${goal.toLocaleString("en-US")} cal`.

In the message handler, after the `if (pending === "goal") { ... }` block:

```ts
    if (pending === "protein") {
      if (lower === "off" || lower === "clear") {
        usersRepo.updateSettings(userId, { daily_protein_goal: null })
        pendingSettings.delete(userId)
        await smartReply(ctx, "Protein goal cleared. Use /settings to view settings.")
        return
      }

      const goal = parseInt(text, 10)
      if (isNaN(goal) || goal < 10 || goal > 500) {
        await smartReply(ctx, "Please enter a number between 10 and 500, or 'off' to clear.")
        return
      }

      usersRepo.updateSettings(userId, { daily_protein_goal: goal })
      pendingSettings.delete(userId)
      await smartReply(ctx, `Daily protein goal set to ${goal} g. Use /settings to view settings.`)
      return
    }
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (8 new → 267 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/commands/settings.test.ts
git commit -m "feat(settings): daily protein goal" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: `/edit` sets protein with `18g`

**Files:**
- Modify: `src/bot/commands/edit.ts`
- Create: `src/bot/commands/edit.test.ts`

**Interfaces:**
- Consumes: `formatItemLine` (Task 4); `updateItem({ protein_g })` (Task 2); `FoodEstimate.protein_g` (Task 5).
- Produces:
  ```ts
  export type EditInput =
    | { kind: "calories"; value: number }
    | { kind: "protein"; value: number }
    | { kind: "invalid"; message: string }
    | { kind: "describe"; text: string }
  export function parseEditInput(text: string): EditInput
  ```

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/edit.test.ts`:

```ts
// src/bot/commands/edit.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../../utils/dates"
import type { AIService } from "../../ai/service"
import { parseEditInput, createEditCommand, createEditMessageHandler, clearEditState } from "./edit"

const USER = 42
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(USER, "maria")
  clearEditState(USER)
})

describe("parseEditInput", () => {
  test("a bare number sets calories", () => {
    expect(parseEditInput("200")).toEqual({ kind: "calories", value: 200 })
    expect(parseEditInput(" 200 ")).toEqual({ kind: "calories", value: 200 })
  })

  test("a number with g sets protein, case-insensitive, with or without a space", () => {
    expect(parseEditInput("18g")).toEqual({ kind: "protein", value: 18 })
    expect(parseEditInput("18 G")).toEqual({ kind: "protein", value: 18 })
    expect(parseEditInput("0g")).toEqual({ kind: "protein", value: 0 })
  })

  test("out-of-range numbers are rejected with a message", () => {
    expect(parseEditInput("0")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("20000")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("1500g")).toEqual({ kind: "invalid", message: "Protein must be between 0 and 1000 g." })
  })

  test("anything else is a description to re-estimate", () => {
    expect(parseEditInput("two eggs and toast")).toEqual({ kind: "describe", text: "two eggs and toast" })
    expect(parseEditInput("200 grams of rice")).toEqual({ kind: "describe", text: "200 grams of rice" })
  })
})

describe("edit flow", () => {
  function commandCtx(text: string) {
    return { from: { id: USER, first_name: "Maria" }, chat: { id: 555, type: "private" }, message: { text }, reply: mock(() => Promise.resolve()) }
  }

  function logToday() {
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    return foodLogsRepo.create(USER, 555, today, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }]).items[0]
  }

  async function editWith(text: string, aiService: AIService = {} as AIService) {
    await createEditCommand(foodLogsRepo, usersRepo)(commandCtx("/edit 1") as unknown as Context)
    const ctx = commandCtx(text)
    await createEditMessageHandler(foodLogsRepo, usersRepo, aiService)(ctx as unknown as Context)
    return ctx
  }

  test("the prompt explains all three inputs", async () => {
    logToday()
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍜 Ramen — 520 cal · 22 g\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200)\n" +
        "• Type a number with g to set protein (e.g. 18g)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("18g updates only protein", async () => {
    const item = logToday()
    const ctx = await editWith("18g")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 520, protein_g: 18 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 18 g", undefined)
  })

  test("a bare number updates only calories", async () => {
    const item = logToday()
    const ctx = await editWith("600")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 600, protein_g: 22 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 600 cal · 22 g", undefined)
  })

  test("an out-of-range number is refused and the edit stays open", async () => {
    const item = logToday()
    const ctx = await editWith("1500g")

    expect(ctx.reply).toHaveBeenCalledWith("Protein must be between 0 and 1000 g.", undefined)
    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ protein_g: 22 })
  })

  test("a description re-estimates and updates every field", async () => {
    const item = logToday()
    const estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Tonkotsu ramen", calories: 650, protein_g: 30, emoji: "🍜" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    const ctx = await editWith("tonkotsu ramen", { estimate } as unknown as AIService)

    expect(estimate).toHaveBeenCalledWith("tonkotsu ramen", expect.any(String), expect.objectContaining({ callType: "edit" }))
    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ description: "Tonkotsu ramen", calories: 650, protein_g: 30 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Tonkotsu ramen — 650 cal · 30 g", undefined)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/bot/commands/edit.test.ts`
Expected: FAIL — `parseEditInput` is not exported.

- [ ] **Step 3: Implement**

In `src/bot/commands/edit.ts`:

Add the import:

```ts
import { formatItemLine } from "../../utils/format"
```

Replace `formatItemsList` and add the parser and prompt helper:

```ts
function formatItemsList(items: (FoodItem & { log_id: number })[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item)}`).join("\n")
}

function editPrompt(item: FoodItem): string {
  return (
    `Editing: ${formatItemLine(item)}\n\n` +
    `What would you like to change?\n` +
    `• Type a number to set calories (e.g. 200)\n` +
    `• Type a number with g to set protein (e.g. 18g)\n` +
    `• Or describe the food to re-estimate\n` +
    `• Type "cancel" to abort`
  )
}

export type EditInput =
  | { kind: "calories"; value: number }
  | { kind: "protein"; value: number }
  | { kind: "invalid"; message: string }
  | { kind: "describe"; text: string }

/** "200" → calories, "18g" → protein, anything else → re-estimate. */
export function parseEditInput(text: string): EditInput {
  const protein = text.match(/^\s*(\d+)\s*g\s*$/i)
  if (protein) {
    const value = parseInt(protein[1], 10)
    if (value < 0 || value > 1000) return { kind: "invalid", message: "Protein must be between 0 and 1000 g." }
    return { kind: "protein", value }
  }

  const calories = text.match(/^\s*(\d+)\s*$/)
  if (calories) {
    const value = parseInt(calories[1], 10)
    if (value < 1 || value > 9999) return { kind: "invalid", message: "Calories must be between 1 and 9999." }
    return { kind: "calories", value }
  }

  return { kind: "describe", text: text.trim() }
}
```

Replace the two inline `Editing: ...` reply blocks (in `createEditCommand` and in the `select` case) with `await smartReply(ctx, editPrompt(item))`.

Replace the whole `case "edit":` block:

```ts
      case "edit": {
        const item = state.items[state.selectedItemIndex!]
        const input = parseEditInput(text)

        if (input.kind === "invalid") {
          await smartReply(ctx, input.message)
          return
        }

        if (input.kind === "calories") {
          foodLogsRepo.updateItem(item.id!, { calories: input.value })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, calories: input.value })}`)
          return
        }

        if (input.kind === "protein") {
          foodLogsRepo.updateItem(item.id!, { protein_g: input.value })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, protein_g: input.value })}`)
          return
        }

        // A description: re-estimate with AI and replace every field.
        try {
          const user = usersRepo.findById(userId)
          const provider = user?.ai_provider ?? "openai"
          const result = await aiService.estimate(input.text, provider, {
            telegramId: userId,
            chatId: ctx.chat?.id ?? null,
            callType: "edit",
          })

          if (result.needsClarification || result.items.length === 0) {
            await smartReply(ctx,
              `Couldn't estimate "${input.text}".\n` +
                `Try a number (calories) or a number with g (protein) instead, or "cancel" to abort.`
            )
            return
          }

          const newItem = result.items[0]
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            protein_g: newItem.protein_g,
            emoji: newItem.emoji,
          })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine(newItem)}`)
        } catch (error) {
          await smartReply(ctx,
            `Couldn't reach AI to estimate. Try a number instead, or "cancel" to abort.`
          )
        }
        break
      }
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (9 new → 276 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/edit.ts src/bot/commands/edit.test.ts
git commit -m "feat(edit): set protein with 18g" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Protein in `/delete`, reminders and `/start`

**Files:**
- Modify: `src/bot/commands/delete.ts`
- Modify: `src/bot/commands/delete.test.ts`
- Modify: `src/jobs/reminders.ts`
- Create: `src/jobs/reminders.test.ts`
- Modify: `src/bot/index.ts:57`

**Interfaces:**
- Consumes: `formatItemLine`, `formatTotals`, `sumTotals` (Task 4); `getTotals` (Task 2); `User.daily_protein_goal` (Task 3).
- Produces: exported `formatReminderMessage(username, mention, totals: DayTotals, dailyGoal, proteinGoal, hasLogs): string`.

- [ ] **Step 1: Update the delete tests**

In `src/bot/commands/delete.test.ts`:

- `logItems` fixture type gains `protein_g?: number | null`:

```ts
function logItems(
  telegramId: number,
  items: { description: string; calories: number; protein_g?: number | null; emoji?: string }[]
) {
```

- Every `Ramen` fixture becomes `{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }`, and every expected `"🗑 Deleted: 🍜 Ramen — 520 cal"` becomes `"🗑 Deleted: 🍜 Ramen — 520 cal · 22 g"` (three occurrences: `resolveDeleteCallback` "deletes one item", handler "a successful press edits the message in place", handler "if answering the callback query fails...").
- In "deletes all of the day's items when the list is unchanged", fixtures become `{ description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" }` and `{ description: "Toast", calories: 150, protein_g: 4, emoji: "🍞" }`; expected edit becomes `"🗑 Deleted 2 entries (330 cal · 16 g protein) for Fri, Sep 25."`.

Run: `bun test src/bot/commands/delete.test.ts` → the four changed expectations FAIL.

- [ ] **Step 2: Implement delete**

In `src/bot/commands/delete.ts`:

- Change the format import: `import { shortHash, formatItemLine, formatTotals, sumTotals } from "../../utils/format"`.
- Delete the local `formatItemLine` function (lines 25-27).
- `promptConfirmAll`: replace `const totalCalories = ...` and the message with:

```ts
  const keyboard = new InlineKeyboard()
    .text(
      "🗑 Delete all",
      encodeDeleteCallback({ action: "all", ownerId, date: targetDate, token: deleteAllToken(items) })
    )
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(
    ctx,
    `Delete all ${items.length} entries for ${formatDateForDisplay(targetDate)}? (${formatTotals(sumTotals(items))} total)`,
    { reply_markup: keyboard }
  )
```

- `confirm_single` typed path: `await smartReply(ctx, \`Deleted: ${formatItemLine(item)}\`)`.
- `confirm_all` typed path: replace the `totalCalories` line and message with `await smartReply(ctx, \`Deleted ${count} entries (${formatTotals(sumTotals(state.items))}) for ${formatDateForDisplay(state.targetDate)}.\`)`.
- `resolveDeleteCallback` `case "all"`: replace the `totalCalories` line and edit with `edit: \`🗑 Deleted ${items.length} entries (${formatTotals(sumTotals(items))}) for ${formatDateForDisplay(cb.date)}.\``.

- [ ] **Step 3: Write the reminder test**

Create `src/jobs/reminders.test.ts`:

```ts
// src/jobs/reminders.test.ts
import { describe, test, expect } from "bun:test"
import { formatReminderMessage } from "./reminders"

describe("formatReminderMessage", () => {
  test("shows both goals with percentages", () => {
    expect(formatReminderMessage("maria", true, { calories: 1450, protein: 82 }, 2000, 120, true)).toBe(
      "@maria Daily check-in 🍽️\n" +
        "Current: 1,450 / 2,000 cal (73%)\n" +
        "Protein: 82 / 120 g (68%)\n" +
        "550 cal remaining — keep it up!"
    )
  })

  test("shows a plain protein line without a protein goal", () => {
    expect(formatReminderMessage(null, false, { calories: 2100, protein: 95 }, 2000, null, true)).toBe(
      "Daily check-in 🍽️\n" +
        "Current: 2,100 / 2,000 cal (105%)\n" +
        "Protein: 95 g\n" +
        "You've reached your goal for today!"
    )
  })

  test("shows both totals without any goal", () => {
    expect(formatReminderMessage(null, false, { calories: 900, protein: 40 }, null, null, true)).toBe(
      "Daily check-in 🍽️\nToday's total: 900 cal\nProtein: 40 g"
    )
  })

  test("omits the protein line when nothing is logged", () => {
    expect(formatReminderMessage(null, false, { calories: 0, protein: 0 }, 2000, 120, false)).toBe(
      "Haven't seen any logs today! 🍽️\nCurrent: 0 cal | Goal: 2,000 cal\n\nUse /log to track what you've eaten."
    )
  })
})
```

Run: `bun test src/jobs/reminders.test.ts` → FAIL (not exported / wrong signature).

- [ ] **Step 4: Implement reminders**

In `src/jobs/reminders.ts`, change the `FoodLogsRepository` import to also bring `DayTotals`, and replace `formatReminderMessage`:

```ts
import { FoodLogsRepository, DayTotals } from "../db/repositories/food-logs"
```

```ts
export function formatReminderMessage(
  username: string | null,
  mention: boolean,
  totals: DayTotals,
  dailyGoal: number | null,
  proteinGoal: number | null,
  hasLogs: boolean
): string {
  const namePrefix = mention && username ? `@${username} ` : ""
  const n = (value: number) => value.toLocaleString("en-US")

  if (!hasLogs) {
    const goalText = dailyGoal ? `Goal: ${n(dailyGoal)} cal` : ""
    return (
      `${namePrefix}Haven't seen any logs today! 🍽️\n` +
      `Current: 0 cal${goalText ? ` | ${goalText}` : ""}\n\n` +
      `Use /log to track what you've eaten.`
    )
  }

  const proteinLine = proteinGoal
    ? `Protein: ${n(totals.protein)} / ${n(proteinGoal)} g (${Math.round((totals.protein / proteinGoal) * 100)}%)`
    : `Protein: ${n(totals.protein)} g`

  if (dailyGoal) {
    const percent = Math.round((totals.calories / dailyGoal) * 100)
    const remaining = dailyGoal - totals.calories
    const closing = remaining > 0 ? `${n(remaining)} cal remaining — keep it up!` : `You've reached your goal for today!`

    return (
      `${namePrefix}Daily check-in 🍽️\n` +
      `Current: ${n(totals.calories)} / ${n(dailyGoal)} cal (${percent}%)\n` +
      `${proteinLine}\n` +
      closing
    )
  }

  return (
    `${namePrefix}Daily check-in 🍽️\n` +
    `Today's total: ${n(totals.calories)} cal\n` +
    proteinLine
  )
}
```

In `createReminderJob`, replace the totals lookup and the call:

```ts
        const totals = foodLogsRepo.getTotals(user.telegram_id, userToday)
        const logs = foodLogsRepo.getByDate(user.telegram_id, userToday)
        const hasLogs = logs.length > 0

        const message = formatReminderMessage(
          user.username,
          user.reminder_mention,
          totals,
          user.daily_goal,
          user.daily_protein_goal,
          hasLogs
        )
```

- [ ] **Step 5: `/start` text**

In `src/bot/index.ts` line 57:

```ts
        "Track your calories and protein with AI-powered estimation.\n\n" +
```

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (4 new → 280 total), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/delete.ts src/bot/commands/delete.test.ts src/jobs/reminders.ts src/jobs/reminders.test.ts src/bot/index.ts
git commit -m "feat(bot): protein in /delete, reminders and /start" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Additive protein fields in the Mini App API

**Files:**
- Modify: `src/web/api.ts`
- Create: `src/web/api.test.ts`

**Interfaces:**
- Consumes: `getDailyTotals` (Task 2), `User.daily_protein_goal` (Task 3), `sumTotals` (Task 4).
- Produces (additive only):
  - `getUser` → `{ daily_goal, daily_protein_goal, username }`
  - `getToday`, `getDay` → `{ date, total, protein, items: [{ id, description, calories, protein_g, emoji }] }`
  - `getStats` → `{ start, end, daily, dailyProtein }`

- [ ] **Step 1: Write the failing test**

Create `src/web/api.test.ts`:

```ts
// src/web/api.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { createApiHandlers } from "./api"

const USER = 42
let api: ReturnType<typeof createApiHandlers>
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let today: string

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(USER, "maria")
  today = getTodayInTimezone(DEFAULT_TIMEZONE)
  api = createApiHandlers({ usersRepo, foodLogsRepo })
})

describe("getUser", () => {
  test("adds daily_protein_goal beside daily_goal", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 120 })
    expect(api.getUser(USER)).toEqual({ daily_goal: 2000, daily_protein_goal: 120, username: "maria" })
  })
})

describe("getToday / getDay", () => {
  test("keep total and add protein, with protein_g on each item", () => {
    foodLogsRepo.create(USER, 1, today, [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
    ])

    const result = api.getToday(USER)

    expect(result.date).toBe(today)
    expect(result.total).toBe(330)
    expect(result.protein).toBe(12)
    expect(result.items).toEqual([
      { id: expect.any(Number), description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { id: expect.any(Number), description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
    ])
    expect(api.getDay(USER, today)).toEqual(result)
  })
})

describe("getStats", () => {
  test("keeps daily as calories and adds dailyProtein", () => {
    foodLogsRepo.create(USER, 1, today, [{ description: "Eggs", calories: 180, protein_g: 12 }])

    const stats = api.getStats(USER, "week")

    expect(Object.keys(stats.daily)).toHaveLength(7)
    expect(Object.keys(stats.dailyProtein)).toEqual(Object.keys(stats.daily))
    expect(stats.daily[today]).toBe(180)
    expect(stats.dailyProtein[today]).toBe(12)
    const yesterday = Object.keys(stats.daily).sort()[5]
    expect(stats.daily[yesterday]).toBe(0)
    expect(stats.dailyProtein[yesterday]).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/web/api.test.ts`
Expected: FAIL — `daily_protein_goal`, `protein`, `dailyProtein` missing.

- [ ] **Step 3: Implement**

Rewrite `src/web/api.ts`:

```ts
// src/web/api.ts
// Every change here is additive: Telegram webviews cache app.html, so a stale
// page must keep working against this server. Never rename or reshape a field.
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, FoodLog } from "../db/repositories/food-logs"
import { getTodayInTimezone, getDateRangeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { sumTotals } from "../utils/format"

export interface ApiDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
}

function dayPayload(date: string, entries: FoodLog[]) {
  const items = entries.flatMap((log) =>
    log.items.map((item) => ({
      id: item.id,
      description: item.description,
      calories: item.calories,
      protein_g: item.protein_g ?? null,
      emoji: item.emoji,
    }))
  )
  const totals = sumTotals(items)
  return { date, total: totals.calories, protein: totals.protein, items }
}

export function createApiHandlers(deps: ApiDeps) {
  const { usersRepo, foodLogsRepo } = deps

  return {
    getUser(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      return {
        daily_goal: user?.daily_goal ?? null,
        daily_protein_goal: user?.daily_protein_goal ?? null,
        username: user?.username ?? null,
      }
    },

    getToday(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      return dayPayload(today, foodLogsRepo.getByDate(telegramId, today))
    },

    getStats(telegramId: number, period: "week" | "month") {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      const days = period === "week" ? 7 : 30
      const dateRange = getDateRangeInTimezone(days, today, timezone)
      const startDate = dateRange[0]
      const endDate = dateRange[dateRange.length - 1]

      const dailyTotals = foodLogsRepo.getDailyTotals(telegramId, startDate, endDate)

      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      const dailyProtein: Record<string, number> = {}
      for (const date of dateRange) {
        daily[date] = dailyTotals[date]?.calories ?? 0
        dailyProtein[date] = dailyTotals[date]?.protein ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
        dailyProtein,
      }
    },

    getDay(telegramId: number, date: string) {
      return dayPayload(date, foodLogsRepo.getByDate(telegramId, date))
    },
  }
}
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (3 new → 283 total), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/api.test.ts
git commit -m "feat(web): protein fields in the Mini App API" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Mini App — protein bar and Calories/Protein toggle

**Files:**
- Modify: `src/web/views/app.html`

**Interfaces:**
- Consumes: `/api/user.daily_protein_goal`, `/api/today.protein`, `items[].protein_g`, `/api/stats.dailyProtein` (Task 16).
- Produces: nothing other code depends on. No automated DOM tests exist for this page; verification is a static check plus a manual pass on the test bot.

The `annotation` block in the chart options is kept and switched with the metric, but note: `chartjs-plugin-annotation` is not loaded on this page today, so no goal line renders for either metric. Fixing that is out of scope.

- [ ] **Step 1: CSS**

In the `<style>` block, after the `.progress-percent` rule, add:

```css
    /* Protein bar under the ring */
    .protein-wrap {
      width: 100%;
      max-width: 280px;
      margin: 0 auto 8px;
    }

    .protein-text {
      font-size: 14px;
      color: var(--hint-color);
      text-align: center;
      margin-bottom: 6px;
    }

    .protein-text strong {
      color: var(--text-color);
    }

    .protein-bar {
      height: 8px;
      border-radius: 4px;
      background: var(--secondary-bg);
      overflow: hidden;
    }

    .protein-bar.hidden {
      display: none;
    }

    .protein-bar-fill {
      height: 100%;
      width: 0;
      border-radius: 4px;
      background: var(--link-color);
      transition: width 0.3s;
    }

    /* Calories | Protein toggle */
    .segmented {
      display: flex;
      background: var(--secondary-bg);
      border-radius: 8px;
      padding: 4px;
      gap: 4px;
      margin-bottom: 12px;
    }

    .segmented button {
      flex: 1;
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--hint-color);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .segmented button.active {
      background: var(--bg-color);
      color: var(--text-color);
    }
```

- [ ] **Step 2: HTML**

In `#today-view`, directly after the closing `</div>` of `.progress-container`:

```html
    <div class="protein-wrap">
      <div class="protein-text" id="today-protein">--</div>
      <div class="protein-bar" id="today-protein-bar"><div class="protein-bar-fill" id="today-protein-fill"></div></div>
    </div>
```

In `#week-view`, before `.chart-container`:

```html
    <div class="segmented" data-view="week">
      <button data-metric="calories" class="active">Calories</button>
      <button data-metric="protein">Protein</button>
    </div>
```

In `#month-view`, after the `30-Day Trend` title and before `.chart-container`:

```html
    <div class="segmented" data-view="month">
      <button data-metric="calories" class="active">Calories</button>
      <button data-metric="protein">Protein</button>
    </div>
```

- [ ] **Step 3: Script — state and helpers**

After `let charts = {};` add:

```js
    // Which series the week/month charts show. Shared by both views on purpose.
    let metric = 'calories';

    const METRICS = {
      calories: { series: (data) => data.daily, goal: (user) => user && user.daily_goal },
      protein: { series: (data) => data.dailyProtein || {}, goal: (user) => user && user.daily_protein_goal },
    };

    function proteinText(grams) {
      return grams === null || grams === undefined ? '? g' : `${grams} g`;
    }
```

- [ ] **Step 4: Script — food log rows and header**

In `renderFoodLog`, replace the `total` and `headerDiv.textContent` lines:

```js
      const total = items.reduce((sum, item) => sum + item.calories, 0);
      const protein = items.reduce((sum, item) => sum + (typeof item.protein_g === 'number' ? item.protein_g : 0), 0);

      const headerDiv = document.createElement('div');
      headerDiv.className = 'food-log-header';
      headerDiv.textContent = `${headerText} • ${total} cal · ${protein} g protein`;
      container.appendChild(headerDiv);
```

and the right-hand column:

```js
        const caloriesDiv = document.createElement('div');
        caloriesDiv.className = 'food-calories';
        caloriesDiv.textContent = `${item.calories} cal · ${proteinText(item.protein_g)}`;
```

- [ ] **Step 5: Script — protein bar**

After `createProgressChart`, add:

```js
    // Protein under the ring: a slim bar when a goal is set, text alone when not.
    function renderProteinBar(current, goal) {
      const text = document.getElementById('today-protein');
      const bar = document.getElementById('today-protein-bar');
      const fill = document.getElementById('today-protein-fill');

      text.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = current.toLocaleString();
      text.appendChild(strong);

      if (goal) {
        text.appendChild(document.createTextNode(` / ${goal.toLocaleString()} g protein`));
        bar.classList.remove('hidden');
        fill.style.width = `${Math.round(Math.min(current / goal, 1) * 100)}%`;
      } else {
        text.appendChild(document.createTextNode(' g protein'));
        bar.classList.add('hidden');
      }
    }
```

- [ ] **Step 6: Script — metric-aware charts and calendar**

Change the three signatures and their first lines:

```js
    function createWeekChart(data, user, metric) {
      const ctx = document.getElementById('week-chart').getContext('2d');
      const series = METRICS[metric].series(data);
      const goal = METRICS[metric].goal(user);
      const dates = Object.keys(data.daily).sort();
      const values = dates.map(d => series[d] || 0);
      const labels = dates.map(d => getDayAbbr(d));
```

(the rest of `createWeekChart` is unchanged — it already reads `values` and `goal`)

```js
    function createMonthChart(data, metric) {
      const ctx = document.getElementById('month-chart').getContext('2d');
      const series = METRICS[metric].series(data);
      const dates = Object.keys(data.daily).sort();
      const values = dates.map(d => series[d] || 0);
```

```js
    function createCalendar(data, metric) {
      const container = document.getElementById('calendar');
      const series = METRICS[metric].series(data);
      const dates = Object.keys(data.daily).sort();
```

and inside its day loop: `const hasData = dataSet.has(dateStr) && series[dateStr] > 0;`

In `selectCalendarDay`, nothing changes.

- [ ] **Step 7: Script — toggle wiring and tab loading**

After the tab-switching block, add:

```js
    // Calories | Protein toggle. One shared metric: switching on Week also
    // switches Month, so the two views never disagree.
    document.querySelectorAll('.segmented button').forEach(btn => {
      btn.addEventListener('click', () => {
        metric = btn.dataset.metric;
        document.querySelectorAll('.segmented button').forEach(b => {
          b.classList.toggle('active', b.dataset.metric === metric);
        });
        if (weekData && userData) createWeekChart(weekData, userData, metric);
        if (monthData) {
          createMonthChart(monthData, metric);
          createCalendar(monthData, metric);
        }
      });
    });
```

In `loadTabData`:

```js
        if (tab === 'today') {
          const [user, today] = await Promise.all([
            userData ? Promise.resolve(userData) : api('/api/user'),
            api('/api/today')
          ]);
          userData = user;

          createProgressChart(today.total, user.daily_goal || 2000);
          renderProteinBar(today.protein || 0, user.daily_protein_goal);
          renderFoodLog(document.getElementById('today-log'), today.items);
        }

        if (tab === 'week') {
          if (!weekData) weekData = await api('/api/stats?period=week');
          if (!userData) userData = await api('/api/user');

          createWeekChart(weekData, userData, metric);
          /* week-log placeholder unchanged */
        }

        if (tab === 'month') {
          if (!monthData) monthData = await api('/api/stats?period=month');

          createMonthChart(monthData, metric);
          createCalendar(monthData, metric);
          /* month-log placeholder unchanged */
        }
```

- [ ] **Step 8: Static check**

```bash
bun -e "const s = await Bun.file('src/web/views/app.html').text(); for (const needle of ['today-protein-fill','data-metric=\"protein\"','dailyProtein','renderProteinBar(','METRICS[metric]']) { if (!s.includes(needle)) throw new Error('missing: ' + needle) } console.log('ok')"
bun test && bunx tsc --noEmit
```

Expected: `ok`; 283 pass; tsc clean (the HTML is not typechecked).

- [ ] **Step 9: Manual check on the test bot** (requires the separate test bot token in `.env` and a tunnel or deployed URL in `APP_URL`; skip if unavailable and say so in the task report)

1. `bun run dev`, send `/log`, log something, send `/today`, tap **📈 View Charts**.
2. Today tab: the ring is unchanged; beneath it `N / G g protein` with a bar (goal set via `/settings`) or `N g protein` alone (no goal). Item rows read `180 cal · 14 g`.
3. Week tab: toggle to Protein; bars change scale; tap a bar; the day log shows both units.
4. Month tab: toggle follows the Week toggle; calendar bold days follow the metric.

- [ ] **Step 10: Commit**

```bash
git add src/web/views/app.html
git commit -m "feat(web): protein bar and metric toggle in the Mini App" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Smoke script, docs, pre-deploy checks

**Files:**
- Modify: `scripts/smoke-providers.ts`
- Modify: `README.md:5, 80, 87-88, 93`
- Modify: `CLAUDE.md` (Architecture → Database, Background Jobs, Database Tables)

- [ ] **Step 1: Smoke script prints protein and can exercise the batch call**

Rewrite `scripts/smoke-providers.ts`:

```ts
// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
//
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini>            # estimate()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --protein  # estimateProtein()
import { AIService } from "../src/ai/service"
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"

const provider = process.argv[2]
const mode = process.argv[3] === "--protein" ? "protein" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]")
  process.exit(1)
}

const db = createTestDb()
const service = new AIService(new CacheRepository(db), new UsageRepository(db))

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
  if (mode === "protein") {
    const descriptions = ["two scrambled eggs", "a slice of toast", "black coffee"]
    const protein = await service.estimateProtein(descriptions, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to estimateProtein`)
    descriptions.forEach((d, i) => console.log(`  ${d}: ${protein[i] ?? "?"} g`))
    if (protein.some((p) => p === null)) {
      console.error("✗ At least one description came back without protein.")
      process.exit(1)
    }
    process.exit(0)
  }

  const result = await service.estimate("two scrambled eggs and a slice of toast", provider, {
    telegramId: 0,
    chatId: null,
    callType: "estimate",
  })
  console.log(`✓ ${provider} responded`)
  console.log(JSON.stringify(result, null, 2))
  if (result.items.length === 0 && !result.needsClarification) {
    console.error("✗ Empty items with no clarification request — the model replied, but not usefully.")
    process.exit(1)
  }
  const missing = result.items.filter((item) => item.protein_g === null).length
  if (missing > 0) {
    console.error(`✗ ${missing} item(s) came back without protein_g.`)
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  process.exit(1)
}
```

Run both modes against the one provider with a working key (Gemini, per `docs/superpowers/HANDOFF.md`):

```bash
bun run scripts/smoke-providers.ts gemini
bun run scripts/smoke-providers.ts gemini --protein
```

Expected: both print `✓` and exit 0, with a whole-number `protein_g` on every item. This is the only live proof that the prompts work; record the actual output in the task report. OpenAI and Anthropic cannot be smoked (no credits / no key) — say so, do not pretend.

- [ ] **Step 2: README**

Line 5: `Describe what you ate in natural language, and TeleCal estimates the calories and protein using AI (OpenAI, Anthropic, or Google Gemini).`

Command table rows:

```markdown
| `/today` | View today's calories and protein |
| `/settings` | Change AI provider, calorie and protein goals, reminders |
| `/admin` | Manage allowed users, view AI usage and cost, backfill protein (admin only) |
```

Privacy section line 93: `...to estimate calories and protein.`

Logging flow step 3: `3. AI estimates calories and protein and may ask clarifying questions`

- [ ] **Step 3: CLAUDE.md**

Under **Database**, add a bullet: ``- `src/db/migrations.ts` adds columns that `IF NOT EXISTS` cannot; runs on every boot after the schema``.

Under **Background Jobs**, add: ``- `backfill-protein.ts` - Fills `protein_g` on pre-feature rows, 25 descriptions per AI call; run via `/admin backfill-protein` ``.

Under **Database Tables**, change the `food_logs` / `food_items` line to: ``- `food_logs` / `food_items` - Log sessions and individual items (`calories`, nullable `protein_g`)`` and the `users` line to: ``- `users` - User preferences (ai_provider, daily_goal, daily_protein_goal, reminder_time)``.

- [ ] **Step 4: Pre-deploy migration check against a pre-feature database file**

```bash
SCRATCH=/private/tmp/claude-501/-Users-raymartvillos-Projects-TeleCal/0ecdb82b-f633-4fb6-944f-6fd39856b0ee/scratchpad
mkdir -p "$SCRATCH" && rm -f "$SCRATCH/pre.db"
sqlite3 "$SCRATCH/pre.db" "
CREATE TABLE users (telegram_id INTEGER PRIMARY KEY, username TEXT, ai_provider TEXT DEFAULT 'gemini', daily_goal INTEGER, reminder_time TEXT, reminder_mention INTEGER DEFAULT 1, timezone TEXT DEFAULT 'Asia/Manila', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE food_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, logged_at TEXT DEFAULT (datetime('now')), target_date TEXT NOT NULL);
CREATE TABLE food_items (id INTEGER PRIMARY KEY AUTOINCREMENT, log_id INTEGER NOT NULL, description TEXT NOT NULL, calories INTEGER NOT NULL, emoji TEXT, FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE);
INSERT INTO users (telegram_id, username, daily_goal) VALUES (1, 'u', 2000);
INSERT INTO food_logs (telegram_id, chat_id, target_date) VALUES (1, 1, '2026-09-30');
INSERT INTO food_items (log_id, description, calories) VALUES (1, 'Ramen', 520);"
DB_PATH="$SCRATCH/pre.db" bun -e "const { initializeDatabase } = await import('./src/db/index.ts'); initializeDatabase(); console.log('boot ok')"
sqlite3 "$SCRATCH/pre.db" "PRAGMA table_info(food_items);" | grep protein_g
sqlite3 "$SCRATCH/pre.db" "SELECT description, calories, protein_g FROM food_items; SELECT daily_goal, daily_protein_goal FROM users;"
```

Expected: `[db] migrated: added food_items.protein_g`, `[db] migrated: added users.daily_protein_goal`, `boot ok`; the column appears; rows read `Ramen|520|` and `2000|`. Run the `bun -e` line a second time: no `migrated` lines, still `boot ok`.

- [ ] **Step 5: Full verification**

```bash
bun test 2>&1 | tail -4
bunx tsc --noEmit && echo "tsc clean"
git status --short   # only the files this task touched
```

Expected: 283 pass / 0 fail; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-providers.ts README.md CLAUDE.md
git commit -m "chore: smoke script prints protein; document protein tracking" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off**

Use `superpowers:finishing-a-development-branch`. Before merging to `main` (which Railway deploys), run the Task 17 manual check on the test bot if it was skipped. After deploy, the admin runs `/admin backfill-protein` once and pastes the two replies into [#10](https://github.com/martin0x/TeleCal/issues/10).

---

## Spec coverage

| Spec section | Task |
|---|---|
| Data model, migration | 1 |
| Repository: `protein_g`, totals, backfill queries | 2 |
| Users: `daily_protein_goal` | 3 |
| Shared formats, `? g`, goal direction wording | 4, 12 |
| AI types, prompts, provider normalization | 5 |
| `estimateProtein` on providers | 6 |
| Service: cache shape check, `estimateProtein`, `backfill` call type | 7 (schema comment in 1) |
| Backfill job | 8 |
| `/admin backfill-protein` | 9 |
| `/log` confirmation, button, logged reply | 10 |
| `/today` | 11 |
| `/week`, `/month` | 12 |
| `/settings` | 13 |
| `/edit` | 14 |
| `/delete`, reminders, `/start` | 15 |
| Web API (additive) | 16 |
| Mini App | 17 |
| Smoke script, docs, rollout | 18 |
| Old in-flight conversations → `? g` | Falls out of Task 4 (`protein_g` undefined renders `? g`) and Task 2 (`FoodItem.protein_g` optional) |

## Deviations from the spec, on purpose

- `FoodItem.protein_g` is optional (`protein_g?: number | null`) rather than required, because items parsed from pre-feature `conversation_state` rows and dozens of existing test fixtures omit it. `FoodEstimate.protein_g` (AI output) is required as specced.
- The settings error reads `...or 'off' to clear.` to match the calorie goal's existing wording, not the spec's `...or 'off'.`
- `/settings` renames the "Daily Goal" line to "Calorie Goal" alongside the button rename, so the two goals are distinguishable in the summary too.
- `/edit` rejects out-of-range numbers with a message instead of silently re-estimating "20000" as a food description.
- `coerceProtein` accepts numeric strings (`"14"`), since a prose-prompted model occasionally quotes numbers; the spec's rule (non-finite → null) still holds.

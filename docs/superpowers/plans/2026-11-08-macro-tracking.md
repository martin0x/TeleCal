# Macro Tracking (Fat, Fiber, Added Sugar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every food item carries fat, fiber and added sugar beside protein, and each user picks which macros their replies and Mini App show.

**Architecture:** A macro registry (`src/macros.ts`) becomes the only place that names a macro. Prompts, parsing, the cache check, repository SQL, formatters, the backfill, `/edit`, `/settings`, the API and the Mini App loop over it. Phase A moves protein onto the registry with no behaviour change. Phase B adds fat, fiber and added sugar as registry entries plus flat columns, so they are estimated and stored but shown to nobody yet. Phase C adds `users.tracked_macros` and makes every reply follow it. Phase D does the Mini App, the API and the docs.

**Tech Stack:** Bun, `bun:sqlite`, grammY, OpenAI SDK (Responses API), `@anthropic-ai/sdk`, `@google/generative-ai`, Chart.js 4 in one static HTML page.

**Spec:** `docs/superpowers/specs/2026-11-08-macro-tracking-design.md`. Read it first; its Decisions table explains every "why". Issue: #30.

## Global Constraints

- Work on the existing branch `feat/macros` (it already holds the spec and this plan). Never push. Never commit to `main`: pushing `main` deploys production.
- Every task ends with `bun test` at **0 fail** and `bunx tsc --noEmit` clean. Baseline before Task 1: **470 pass / 0 fail across 54 files**, tsc clean. Test counts below are a guide; the gate is 0 fail and a clean tsc.
- `scripts/` is outside `tsconfig.json`'s `include`. Any task that changes a formatter signature or the smoke script also runs the **scripts typecheck**:
  `bunx tsc --noEmit --ignoreConfig --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types bun-types scripts/telegram-mock/render.ts scripts/smoke-providers.ts`
  It must exit 0 with no output.
- Macro values are whole grams. `null` means unknown; `0` is a real value. A value above 1000 from the AI is `null`. `/edit` accepts 0–1000.
- Display formats, verbatim from the spec:
  - Item lines: calories first, then protein with its bare unit (`38 g`), then `24 g fat`, `1 g fiber`, `2 g sugar`. Unknown: `? g`, `? g fat`, `? g fiber`, `? g sugar`.
  - Totals: `625 cal · 42 g protein · 24 g fat · 2 g fiber · 2 g added sugar`.
  - Order on screen is always the registry's: protein, fat, fiber, added sugar.
- With the default macros (protein only), every log, `/today`, `/week`, `/month`, `/edit`, `/delete` and reminder reply stays byte-for-byte what it is today. In Tasks 1–6 no existing test's expected user-facing chat text may change. The one deliberate exception is the admin-only `/admin backfill-protein` replies, which Task 5 renames to `/admin backfill-macros` as the spec says. Test call sites may gain arguments, and fixtures may be rewritten in registry-agnostic form, e.g. `{ ...zeroTotals(), calories: 350, protein: 16 }`.
- No emoji for fat, fiber or added sugar, in chat or in the Mini App. New Mini App elements are text only.
- Web API changes are additive. `total`, `protein`, `daily`, `dailyProtein` and `protein_g` keep their names and meaning.
- Tests use `createTestDb()` from `src/db/test-helpers.ts`, never hand-copied DDL. The one exception is `migrations.test.ts`, which deliberately builds a pre-feature database.
- Commit after every task with a conventional-commit subject. The message body ends with exactly this line: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Copy the trailer exactly as written. Do not replace the model name with your own model's name.
- Do not edit the spec. If this plan and the spec disagree, stop and report rather than picking one.

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `src/macros.ts` | The registry (`MACROS`) and every helper that loops over it: types, tracked-macro parsing, keyword lookup, totals arithmetic, value records |
| `src/macros.test.ts` | Registry and helper tests |
| `src/ai/prompt.test.ts` | Every macro appears in both prompts |
| `src/web/app-page.test.ts` | The Mini App script parses and labels every macro |

**Renamed**

| From | To |
|---|---|
| `src/jobs/backfill-protein.ts` | `src/jobs/backfill-macros.ts` |
| `src/jobs/backfill-protein.test.ts` | `src/jobs/backfill-macros.test.ts` |

**Modified**

| File | Change |
|---|---|
| `src/db/schema.sql`, `src/db/migrations.ts` | `fat_g`, `fiber_g`, `added_sugar_g` on `food_items`; `tracked_macros` on `users` |
| `src/db/repositories/food-logs.ts` | Insert, update and totals loop over the registry; backfill queries for any missing macro |
| `src/db/repositories/users.ts` | `tracked_macros` |
| `src/utils/format.ts` | Formatters take the macros to show; `formatNumber` exported |
| `src/ai/types.ts`, `parse.ts`, `prompt.ts`, `service.ts`, `providers/*.ts` | Registry-driven estimate shape, coercion, schemas, cache check; `estimateMacros` replaces `estimateProtein` |
| `src/jobs/reminders.ts`, `src/jobs/retry-pending.ts` | Follow the user's macros |
| `src/bot/conversations/log-flow.ts`, `src/bot/commands/{log,today,stats,edit,delete,settings,admin}.ts`, `src/bot/help.ts`, `src/bot/index.ts` | As specced |
| `src/web/api.ts`, `src/web/views/app.html` | Additive fields; macros in the Mini App |
| `src/web/views/landing.html`, `README.md`, `CHANGELOG.md`, `CLAUDE.md` | Copy and docs |
| `scripts/smoke-providers.ts`, `scripts/telegram-mock/render.ts` | `--macros`; new formatter signatures |

---

## Phase A — Protein on the registry, no behaviour change

### Task 1: Macro registry

**Files:**
- Create: `src/macros.ts`
- Test: `src/macros.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (every later task imports these from `src/macros.ts`):
  - `MACROS` (readonly tuple; each entry `{ key, column, name, itemLabel, totalLabel, keywords, rule }`)
  - types `Macro`, `MacroKey`, `MacroColumn`, `Totals = { calories: number } & Record<MacroKey, number>`, `MacroValues = Record<MacroColumn, number | null>`
  - `DEFAULT_MACROS: readonly MacroKey[]` (`["protein"]`), `MAX_GRAMS = 1000`
  - `isMacroKey(value: string): value is MacroKey`, `getMacro(key: MacroKey): Macro`
  - `parseTrackedMacros(raw: string | null | undefined): MacroKey[]`, `serializeTrackedMacros(keys: readonly MacroKey[]): string`
  - `macroByKeyword(word: string): Macro | undefined`, `withMacro(keys: readonly MacroKey[], key: MacroKey): MacroKey[]`
  - `zeroTotals(): Totals`, `addTotals(a: Totals, b: Totals): Totals`, `averageTotals(totals: Totals, days: number): Totals`
  - `emptyMacroValues(): MacroValues`, `macroValuesOf(item: Partial<MacroValues>): MacroValues`

- [ ] **Step 1: Write the failing tests**

Create `src/macros.test.ts`. The tests are registry-agnostic where they can be, so they keep passing when Task 6 adds three entries:

```ts
// src/macros.test.ts
import { describe, test, expect } from "bun:test"
import {
  MACROS,
  DEFAULT_MACROS,
  isMacroKey,
  getMacro,
  parseTrackedMacros,
  serializeTrackedMacros,
  macroByKeyword,
  withMacro,
  zeroTotals,
  addTotals,
  averageTotals,
  emptyMacroValues,
  macroValuesOf,
} from "./macros"

const ALL = MACROS.map((m) => m.key)

describe("registry", () => {
  test("protein comes first, with its bare item unit", () => {
    expect(MACROS[0]).toMatchObject({ key: "protein", column: "protein_g", itemLabel: "", totalLabel: "protein" })
  })

  test("keys and columns are unique, and every rule names its column", () => {
    expect(new Set(ALL).size).toBe(MACROS.length)
    expect(new Set(MACROS.map((m) => m.column)).size).toBe(MACROS.length)
    for (const m of MACROS) expect(m.rule).toStartWith(`- ${m.column}: `)
  })

  test("the default is protein only", () => {
    expect(DEFAULT_MACROS).toEqual(["protein"])
  })
})

describe("isMacroKey / getMacro", () => {
  test("know registry keys only", () => {
    expect(isMacroKey("protein")).toBe(true)
    expect(isMacroKey("carbs")).toBe(false)
    expect(getMacro("protein").name).toBe("Protein")
  })
})

describe("parseTrackedMacros", () => {
  test("null or undefined means the default", () => {
    expect(parseTrackedMacros(null)).toEqual(["protein"])
    expect(parseTrackedMacros(undefined)).toEqual(["protein"])
  })

  test("an empty string means none", () => {
    expect(parseTrackedMacros("")).toEqual([])
  })

  test("drops unknown keys and tolerates spaces", () => {
    expect(parseTrackedMacros(" protein , carbs")).toEqual(["protein"])
  })

  test("returns registry order whatever the stored order", () => {
    expect(parseTrackedMacros([...ALL].reverse().join(","))).toEqual(ALL)
  })
})

describe("serializeTrackedMacros", () => {
  test("round-trips through parseTrackedMacros, including none", () => {
    expect(parseTrackedMacros(serializeTrackedMacros(ALL))).toEqual(ALL)
    expect(serializeTrackedMacros([])).toBe("")
    expect(parseTrackedMacros(serializeTrackedMacros([]))).toEqual([])
  })
})

describe("macroByKeyword", () => {
  test("ignores case and extra spaces", () => {
    expect(macroByKeyword(" PROTEIN ")?.key).toBe("protein")
  })

  test("is undefined for anything else", () => {
    expect(macroByKeyword("carbs")).toBeUndefined()
    expect(macroByKeyword("")).toBeUndefined()
  })
})

describe("withMacro", () => {
  test("adds a key once, in registry order", () => {
    expect(withMacro([], "protein")).toEqual(["protein"])
    expect(withMacro(["protein"], "protein")).toEqual(["protein"])
  })
})

describe("totals helpers", () => {
  test("zeroTotals has calories and one zero per macro", () => {
    const zero = zeroTotals()
    expect(Object.keys(zero).sort()).toEqual(["calories", ...ALL].sort())
    expect(Object.values(zero).every((v) => v === 0)).toBe(true)
  })

  test("addTotals adds key by key; averageTotals divides and rounds", () => {
    const a = { ...zeroTotals(), calories: 100, protein: 10 }
    const b = { ...zeroTotals(), calories: 51, protein: 5 }
    expect(addTotals(a, b)).toEqual({ ...zeroTotals(), calories: 151, protein: 15 })
    expect(averageTotals({ ...zeroTotals(), calories: 1000, protein: 75 }, 3)).toEqual({
      ...zeroTotals(),
      calories: 333,
      protein: 25,
    })
  })
})

describe("macro values", () => {
  test("emptyMacroValues is null for every column", () => {
    expect(Object.keys(emptyMacroValues()).sort()).toEqual(MACROS.map((m) => m.column).sort())
    expect(Object.values(emptyMacroValues()).every((v) => v === null)).toBe(true)
  })

  test("macroValuesOf keeps known values and nulls the rest", () => {
    expect(macroValuesOf({ protein_g: 12 })).toEqual({ ...emptyMacroValues(), protein_g: 12 })
    expect(macroValuesOf({})).toEqual(emptyMacroValues())
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test src/macros.test.ts`
Expected: FAIL, `Cannot find module './macros'`.

- [ ] **Step 3: Write the registry**

Create `src/macros.ts`:

```ts
// src/macros.ts
// The one place that names a macro. Calories are not in here: they are
// always tracked and always shown. Prompts, parsing, the cache check,
// repository SQL, formatting, /edit, /settings and the web API all loop over
// MACROS, so a new macro is an entry here plus its column. See
// docs/superpowers/specs/2026-11-08-macro-tracking-design.md.

export const MACROS = [
  {
    key: "protein",
    column: "protein_g",
    /** /settings, /today and reminders. */
    name: "Protein",
    /** After the grams on an item line. Protein's is empty: its bare "g" predates the other macros. */
    itemLabel: "",
    /** After the grams in a total. */
    totalLabel: "protein",
    /** Words that may follow "Ng" in /edit. */
    keywords: ["protein"],
    /** The prompt line asking the model for this value. */
    rule: "- protein_g: estimated grams of protein for the item, as a whole number",
  },
] as const

export type Macro = (typeof MACROS)[number]
export type MacroKey = Macro["key"]
export type MacroColumn = Macro["column"]
/** A meal's or a day's calories plus every macro, unknown values counted as 0. */
export type Totals = { calories: number } & Record<MacroKey, number>
/** One item's macros by column. null = unknown. */
export type MacroValues = Record<MacroColumn, number | null>

/** What a user tracks until they change it in /settings → Macros. */
export const DEFAULT_MACROS: readonly MacroKey[] = ["protein"]

/** Above this a value is garbage, not food: the AI's is dropped and /edit refuses it. */
export const MAX_GRAMS = 1000

const KEYS: ReadonlySet<string> = new Set(MACROS.map((m) => m.key))

export function isMacroKey(value: string): value is MacroKey {
  return KEYS.has(value)
}

export function getMacro(key: MacroKey): Macro {
  return MACROS.find((m) => m.key === key)!
}

/** users.tracked_macros → keys in registry order. Unknown keys are dropped; null means the default; "" means none. */
export function parseTrackedMacros(raw: string | null | undefined): MacroKey[] {
  if (raw === null || raw === undefined) return [...DEFAULT_MACROS]
  const wanted = new Set(raw.split(",").map((part) => part.trim()))
  return MACROS.filter((m) => wanted.has(m.key)).map((m) => m.key)
}

export function serializeTrackedMacros(keys: readonly MacroKey[]): string {
  return MACROS.filter((m) => keys.includes(m.key))
    .map((m) => m.key)
    .join(",")
}

/** "Added  Sugar" → added sugar. Case and extra spaces don't matter. */
export function macroByKeyword(word: string): Macro | undefined {
  const wanted = word.trim().toLowerCase().replace(/\s+/g, " ")
  return MACROS.find((m) => (m.keywords as readonly string[]).includes(wanted))
}

/** keys plus key, in registry order. */
export function withMacro(keys: readonly MacroKey[], key: MacroKey): MacroKey[] {
  return MACROS.filter((m) => m.key === key || keys.includes(m.key)).map((m) => m.key)
}

export function zeroTotals(): Totals {
  return { calories: 0, ...Object.fromEntries(MACROS.map((m) => [m.key, 0])) } as Totals
}

export function addTotals(a: Totals, b: Totals): Totals {
  const out = { ...a, calories: a.calories + b.calories }
  for (const m of MACROS) out[m.key] = a[m.key] + b[m.key]
  return out
}

/** Each value divided by days, rounded. */
export function averageTotals(totals: Totals, days: number): Totals {
  const out = { ...totals, calories: Math.round(totals.calories / days) }
  for (const m of MACROS) out[m.key] = Math.round(totals[m.key] / days)
  return out
}

export function emptyMacroValues(): MacroValues {
  return Object.fromEntries(MACROS.map((m) => [m.column, null])) as MacroValues
}

/** Every macro column of an item; missing ones become null. */
export function macroValuesOf(item: Partial<MacroValues>): MacroValues {
  return Object.fromEntries(MACROS.map((m) => [m.column, item[m.column] ?? null])) as MacroValues
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun test src/macros.test.ts`
Expected: PASS, 16 tests.

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/macros.ts src/macros.test.ts
git commit -m "feat(macros): macro registry, protein only" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Food items and day totals follow the registry

**Files:**
- Modify: `src/db/repositories/food-logs.ts` (types at the top, `create`, `getByDate`, `getTotals`, `getDailyTotals`, `updateItem`)
- Test: `src/db/repositories/food-logs.test.ts`, `src/bot/conversations/log-flow.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MacroColumn`, `Totals`, `zeroTotals` from Task 1.
- Produces:
  - `type FoodItem = { id?: number; description: string; calories: number; emoji?: string } & Partial<Record<MacroColumn, number | null>>`
  - `type DayTotals = Totals`
  - `updateItem(itemId, updates: Partial<{ description: string; calories: number; emoji: string } & Record<MacroColumn, number | null>>)`
  - `getTotals` and `getDailyTotals` return one key per registry macro beside `calories`.
  - The backfill methods (`listDescriptionsMissingProtein`, `countItemsMissingProtein`, `setProteinForDescription`) are untouched here; Task 5 replaces them.

This is a refactor: no expected value changes. First make the tests registry-agnostic, then change the code under them.

- [ ] **Step 1: Make the totals expectations registry-agnostic**

In `src/db/repositories/food-logs.test.ts`, add the import:

```ts
import { MACROS, zeroTotals } from "../../macros"
```

Then replace these four expectations:

```ts
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 350, protein: 16 })
```
with
```ts
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ ...zeroTotals(), calories: 350, protein: 16 })
```

```ts
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 0, protein: 0 })
```
with
```ts
    expect(repo.getTotals(123, "2026-01-31")).toEqual(zeroTotals())
```

```ts
    expect(totals["2026-01-30"]).toEqual({ calories: 1000, protein: 60 })
    expect(totals["2026-01-31"]).toEqual({ calories: 1500, protein: 0 })
```
with
```ts
    expect(totals["2026-01-30"]).toEqual({ ...zeroTotals(), calories: 1000, protein: 60 })
    expect(totals["2026-01-31"]).toEqual({ ...zeroTotals(), calories: 1500, protein: 0 })
```

Add one guard test after `"gets entries for a specific date"`:

```ts
  test("items read back carry every macro column, null when unknown", () => {
    repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180 }])
    const item = repo.getByDate(123, "2026-01-31")[0].items[0] as Record<string, unknown>
    for (const m of MACROS) expect(item[m.column]).toBeNull()
  })
```

- [ ] **Step 2: Move `log-flow.test.ts` onto `createTestDb()`**

Its hand-copied `food_items` would miss the columns Task 6 adds. In `src/bot/conversations/log-flow.test.ts`, add:

```ts
import { createTestDb } from "../../db/test-helpers"
```

Replace everything in `beforeEach` from `db = new Database(":memory:")` through the closing of the last `db.run(` (the `pending_entries` table) with:

```ts
    db = createTestDb()
    // food_logs.telegram_id references users in the real schema.
    db.run("INSERT INTO users (telegram_id) VALUES (123)")
```

Keep `let db: Database` and its import.

- [ ] **Step 3: Run the tests (green before the refactor)**

Run: `bun test src/db/repositories/food-logs.test.ts src/bot/conversations/log-flow.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 4: Refactor the repository**

In `src/db/repositories/food-logs.ts`, replace the imports and the `FoodItem` and `DayTotals` interfaces at the top (everything above `export interface FoodLog`) with:

```ts
// src/db/repositories/food-logs.ts
import { Database } from "bun:sqlite"
import { MACROS, type MacroColumn, type Totals } from "../../macros"

/**
 * A logged item. The macro columns (protein_g, …) are whole grams; null means
 * unknown: a row from before that macro existed, or a model miss. Optional on
 * input only; rows read back always carry every column.
 */
export type FoodItem = {
  id?: number
  description: string
  calories: number
  emoji?: string
} & Partial<Record<MacroColumn, number | null>>

export type DayTotals = Totals

type FoodItemRow = { id: number; description: string; calories: number; emoji: string | null } & Record<
  MacroColumn,
  number | null
>

const MACRO_COLUMNS = MACROS.map((m) => m.column)
/** `COALESCE(SUM(fi.protein_g), 0) AS protein, …`, built from registry constants, never from input. */
const MACRO_SUMS = MACROS.map((m) => `COALESCE(SUM(fi.${m.column}), 0) AS ${m.key}`).join(", ")
```

In `create`, replace the item statement and the `insertedItems` mapping with:

```ts
    const itemStmt = this.db.prepare(`
      INSERT INTO food_items (log_id, description, calories, ${MACRO_COLUMNS.join(", ")}, emoji)
      VALUES (?, ?, ?, ${MACRO_COLUMNS.map(() => "?").join(", ")}, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        ...MACRO_COLUMNS.map((column) => item[column] ?? null),
        item.emoji ?? null
      ) as FoodItemRow
      return { ...row, emoji: row.emoji ?? undefined }
    })
```

In `getByDate`, replace the inline item row type:

```ts
      const items = itemsStmt.all(log.id) as {
        id: number
        description: string
        calories: number
        protein_g: number | null
        emoji: string | null
      }[]
```
with
```ts
      const items = itemsStmt.all(log.id) as FoodItemRow[]
```

Replace `getTotals` and `getDailyTotals` with:

```ts
  getTotals(telegramId: number, targetDate: string): DayTotals {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(fi.calories), 0) AS calories, ${MACRO_SUMS}
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
      SELECT fl.target_date, COALESCE(SUM(fi.calories), 0) AS calories, ${MACRO_SUMS}
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ?
        AND fl.target_date >= ?
        AND fl.target_date <= ?
      GROUP BY fl.target_date
    `)
    const rows = stmt.all(telegramId, startDate, endDate) as ({ target_date: string } & DayTotals)[]
    return Object.fromEntries(rows.map(({ target_date, ...totals }) => [target_date, totals as DayTotals]))
  }
```

Replace `updateItem` with:

```ts
  updateItem(
    itemId: number,
    updates: Partial<{ description: string; calories: number; emoji: string } & Record<MacroColumn, number | null>>
  ): void {
    // Column names come from this list and the registry, never from the keys of `updates`.
    const columnUpdates: { column: "description" | "calories" | "emoji" | MacroColumn; value: string | number | null }[] = []

    if (updates.description !== undefined) {
      columnUpdates.push({ column: "description", value: updates.description })
    }
    if (updates.calories !== undefined) {
      columnUpdates.push({ column: "calories", value: updates.calories })
    }
    for (const column of MACRO_COLUMNS) {
      const value = updates[column]
      if (value !== undefined) columnUpdates.push({ column, value })
    }
    if (updates.emoji !== undefined) {
      columnUpdates.push({ column: "emoji", value: updates.emoji })
    }

    if (columnUpdates.length === 0) return

    const setClause = columnUpdates.map((u) => `${u.column} = ?`).join(", ")
    const values = columnUpdates.map((u) => u.value)

    const stmt = this.db.prepare(`UPDATE food_items SET ${setClause} WHERE id = ?`)
    stmt.run(...values, itemId)
  }
```

- [ ] **Step 5: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail (one new test); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/food-logs.ts src/db/repositories/food-logs.test.ts src/bot/conversations/log-flow.test.ts
git commit -m "refactor(db): food item macros and day totals follow the registry" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Formatters take the macros to show

**Files:**
- Modify: `src/utils/format.ts`, `src/bot/commands/today.ts`, `src/bot/commands/stats.ts`, `src/jobs/reminders.ts`, `src/bot/conversations/log-flow.ts`, `src/bot/commands/log.ts`, `src/bot/commands/delete.ts`, `src/bot/commands/edit.ts`, `src/jobs/retry-pending.ts`, `scripts/telegram-mock/render.ts`
- Test: `src/utils/format.test.ts`, `src/bot/commands/today.test.ts`, `src/bot/commands/stats.test.ts`, `src/jobs/reminders.test.ts`, `src/bot/commands/log.test.ts`, `src/bot/conversations/log-flow.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `Macro`, `MacroKey`, `MacroColumn`, `Totals`, `DEFAULT_MACROS`, `zeroTotals`, `addTotals`, `averageTotals` (Task 1); `DayTotals` (Task 2).
- Produces (in `src/utils/format.ts`):
  - `type SummaryItem = { description: string; calories: number; emoji?: string | null } & Partial<Record<MacroColumn, number | null>>`
  - `formatNumber(value: number): string`
  - `sumTotals(items): Totals`
  - `formatItemLine(item: SummaryItem, macros: readonly MacroKey[]): string`
  - `formatTotals(totals: Totals, macros: readonly MacroKey[]): string`
  - `formatItemsSummary(items: SummaryItem[], macros: readonly MacroKey[], opts?: { struck?: boolean }): string`
  - `formatGoalProgress({ emoji?, label, current, goal, unit })`: `emoji` is now optional.
  - `formatProtein` is removed (only its own test used it).
  - `LogFlowResult.confirm` and `buildLogConfirmKeyboard`'s `confirm` become `{ token: string; totals: Totals }`.

Every caller passes `DEFAULT_MACROS` for now. Task 8 and Task 9 switch them to the user's macros.

- [ ] **Step 1: Write the failing tests and update format.test.ts call sites**

In `src/utils/format.test.ts`:

1. Replace the import block with:

```ts
import {
  formatUsd,
  formatTokens,
  escapeHtml,
  formatItemsSummary,
  shortHash,
  sumTotals,
  formatItemLine,
  formatTotals,
  formatGoalProgress,
  createProgressBar,
  formatNumber,
} from "./format"
import { zeroTotals, type MacroKey } from "../macros"

const PROTEIN: MacroKey[] = ["protein"]
```

2. Add `, PROTEIN` as the second argument of every existing `formatItemsSummary(...)` call (before `{ struck: true }` where present) and every existing `formatItemLine(...)` call. Expected strings stay as they are.

3. In `describe("sumTotals")`, replace the two expectations with:

```ts
    expect(sumTotals([{ calories: 100, protein_g: 10 }, { calories: 50, protein_g: null }, { calories: 25 }])).toEqual({
      ...zeroTotals(),
      calories: 175,
      protein: 10,
    })
```
and
```ts
    expect(sumTotals([])).toEqual(zeroTotals())
```

4. Delete the whole `describe("formatProtein", …)` block.

5. In `describe("formatTotals")`, replace the two expectations with:

```ts
    expect(formatTotals({ ...zeroTotals(), calories: 335, protein: 28 }, PROTEIN)).toBe("335 cal · 28 g protein")
    expect(formatTotals({ ...zeroTotals(), calories: 1450, protein: 1020 }, PROTEIN)).toBe("1,450 cal · 1,020 g protein")
```

6. Append these new tests at the end of the file:

```ts
describe("with no macros", () => {
  const items = [
    { description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
    { description: "Black coffee", calories: 5, protein_g: 0, emoji: "☕" },
  ]

  test("item lines show calories only", () => {
    expect(formatItemLine(items[0], [])).toBe("🍳 2 scrambled eggs — 180 cal")
  })

  test("totals show calories only", () => {
    expect(formatTotals({ ...zeroTotals(), calories: 335, protein: 28 }, [])).toBe("335 cal")
  })

  test("the summary shows calories only", () => {
    expect(formatItemsSummary(items, [])).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</blockquote>\n\n<b>Total: 185 cal</b>"
    )
  })
})

describe("formatGoalProgress without an emoji", () => {
  test("starts with the label", () => {
    expect(formatGoalProgress({ label: "Fat", current: 36, goal: null, unit: "g" })).toBe("Fat: 36 g")
  })
})

describe("formatNumber", () => {
  test("groups thousands", () => {
    expect(formatNumber(1450)).toBe("1,450")
    expect(formatNumber(95)).toBe("95")
  })
})
```

- [ ] **Step 2: Run them to see the new ones fail**

Run: `bun test src/utils/format.test.ts`
Expected: FAIL. The "with no macros" tests get `· 14 g` and `· 28 g protein` back; `formatGoalProgress` gives `undefined Fat: 36 g`; `formatNumber` is not a function.

- [ ] **Step 3: Rewrite the formatters**

In `src/utils/format.ts`, replace the import line with:

```ts
import { createHash } from "node:crypto"
import { MACROS, zeroTotals, type Macro, type MacroColumn, type MacroKey, type Totals } from "../macros"
```

Replace everything from `export interface SummaryItem {` down to the end of `formatItemsSummary` (keep `formatItemsSummary`'s doc comment) with:

```ts
/** An item as the formatters see it. Macro columns are whole grams; null or missing = unknown. */
export type SummaryItem = {
  description: string
  calories: number
  emoji?: string | null
} & Partial<Record<MacroColumn, number | null>>

/** 1450 → "1,450". */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

const n = formatNumber

function isKnown(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** The registry entries a user tracks, in registry order. */
function selected(macros: readonly MacroKey[]): Macro[] {
  return MACROS.filter((m) => macros.includes(m.key))
}

/** Calories and every macro across items. Unknown values count as 0. */
export function sumTotals(items: Pick<SummaryItem, "calories" | MacroColumn>[]): Totals {
  const totals = zeroTotals()
  for (const item of items) {
    totals.calories += item.calories
    for (const m of MACROS) {
      const value = item[m.column]
      if (isKnown(value)) totals[m.key] += value
    }
  }
  return totals
}

/** `38 g` for protein, `24 g fat` for the rest; `? g` and `? g fat` when unknown. */
function itemAmount(macro: Macro, value: number | null | undefined): string {
  const grams = isKnown(value) ? `${value} g` : "? g"
  return macro.itemLabel ? `${grams} ${macro.itemLabel}` : grams
}

/**
 * One item, plain text: `🍳 2 scrambled eggs — 180 cal · 14 g`, then each
 * other tracked macro. String() guards against a model that returns a number
 * where a string belongs.
 */
export function formatItemLine(item: SummaryItem, macros: readonly MacroKey[]): string {
  const head = `${String(item.emoji ?? "🍽️")} ${String(item.description)} — ${String(item.calories)} cal`
  return [head, ...selected(macros).map((m) => itemAmount(m, item[m.column]))].join(" · ")
}

/** `335 cal · 28 g protein`: the total spells out what the item lines abbreviate. */
export function formatTotals(totals: Totals, macros: readonly MacroKey[]): string {
  return [`${n(totals.calories)} cal`, ...selected(macros).map((m) => `${n(totals[m.key])} g ${m.totalLabel}`)].join(" · ")
}

/**
 * Items in a quote box with a bold total a blank line beneath, for messages
 * sent with parse_mode "HTML". Callers leave a blank line above it too, since
 * Telegram draws the quote flush against the lines around it. The quote box
 * replaces a row of ─ characters, which wrapped onto a second line on narrow
 * screens: no character count fits every client, and a blockquote does not
 * depend on width at all.
 */
export function formatItemsSummary(
  items: SummaryItem[],
  macros: readonly MacroKey[],
  opts: { struck?: boolean } = {}
): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items.map((item) => escapeHtml(formatItemLine(item, macros))).join("\n")
  return `<blockquote>${strike(lines)}</blockquote>\n\n<b>${strike(`Total: ${formatTotals(sumTotals(items), macros)}`)}</b>`
}
```

Replace `formatGoalProgress` (with its doc comment) by:

```ts
/**
 * A goal block for /today and friends. One line without a goal; with a goal,
 * the headline, a 10-block bar with percentage, and a remaining/over/reached
 * line. Same shape for calories (a ceiling) and protein (a floor): /today says
 * "remaining" for both; the weekly stats carry the direction. The lines for
 * fat, fiber and added sugar have no emoji and no goal.
 */
export function formatGoalProgress(opts: {
  emoji?: string
  label: string
  current: number
  goal: number | null | undefined
  unit: string
}): string {
  const { emoji, label, current, goal, unit } = opts
  const title = emoji ? `${emoji} ${label}` : label
  if (!goal) return `${title}: ${n(current)} ${unit}`

  const percentage = Math.round((current / goal) * 100)
  const remaining = goal - current
  let out = `${title}: ${n(current)} / ${n(goal)} ${unit}\n${createProgressBar(percentage)} ${percentage}%\n`
  if (remaining > 0) out += `✨ ${n(remaining)} ${unit} remaining`
  else if (remaining < 0) out += `⚠️ ${n(Math.abs(remaining))} ${unit} over goal`
  else out += `🎯 Goal reached!`
  return out
}
```

- [ ] **Step 4: Update every caller to pass `DEFAULT_MACROS`**

`src/bot/commands/today.ts`: add `import { DEFAULT_MACROS } from "../../macros"`, and change `formatItemLine(item)` to `formatItemLine(item, DEFAULT_MACROS)`.

`src/bot/commands/stats.ts`:
- Replace the format import with `import { formatTotals, formatNumber } from "../../utils/format"` and add `import { DEFAULT_MACROS, zeroTotals, addTotals, averageTotals } from "../../macros"`.
- Replace `const n = (value: number) => value.toLocaleString("en-US")` with `const n = formatNumber`.
- Replace the `total` and `avg` computations:

```ts
  const total = loggedDays.reduce(addTotals, zeroTotals())
  const avg = averageTotals(total, daysWithData)
```

- Change the three `formatTotals(x)` calls to `formatTotals(x, DEFAULT_MACROS)` (`week`, `total`, `avg`).
- Replace `splitIntoWeeks` with:

```ts
function splitIntoWeeks(dateRange: string[], dailyTotals: Record<string, DayTotals>): DayTotals[] {
  const weeks: DayTotals[] = []
  let week = zeroTotals()

  for (let i = 0; i < dateRange.length; i++) {
    const day = dailyTotals[dateRange[i]]
    if (day) week = addTotals(week, day)
    if ((i + 1) % 7 === 0) {
      weeks.push(week)
      week = zeroTotals()
    }
  }

  // Add remaining days
  if (week.calories > 0 || dateRange.length % 7 !== 0) {
    weeks.push(week)
  }

  return weeks
}
```

`src/jobs/reminders.ts`: add `import { formatNumber } from "../utils/format"`, delete the `const n = (value: number) => value.toLocaleString("en-US")` line inside `formatReminderMessage`, and add `const n = formatNumber` at module level under the imports.

`src/bot/conversations/log-flow.ts`:
- Add `import { DEFAULT_MACROS, type Totals } from "../../macros"`.
- Change `confirm?: { token: string; totals: { calories: number; protein: number } }` to `confirm?: { token: string; totals: Totals }`.
- Change `formatTotals(sumTotals(items))` to `formatTotals(sumTotals(items), DEFAULT_MACROS)`.
- Change all four `formatItemsSummary(items)` / `formatItemsSummary(items, { struck: true })` calls to `formatItemsSummary(items, DEFAULT_MACROS)` / `formatItemsSummary(items, DEFAULT_MACROS, { struck: true })`.

`src/bot/commands/log.ts`: add `import type { Totals } from "../../macros"` and change the `confirm` parameter type of `buildLogConfirmKeyboard` to `{ token: string; totals: Totals }`.

`src/bot/commands/delete.ts`: add `import { DEFAULT_MACROS } from "../../macros"`; change every `formatItemLine(item)` to `formatItemLine(item, DEFAULT_MACROS)` (4 places) and every `formatTotals(sumTotals(…))` to `formatTotals(sumTotals(…), DEFAULT_MACROS)` (3 places).

`src/bot/commands/edit.ts`: add `import { DEFAULT_MACROS } from "../../macros"`; change every `formatItemLine(x)` to `formatItemLine(x, DEFAULT_MACROS)` (5 places).

`src/jobs/retry-pending.ts`: add `import { DEFAULT_MACROS } from "../macros"`; change `formatItemsSummary(result.items)` to `formatItemsSummary(result.items, DEFAULT_MACROS)`.

`scripts/telegram-mock/render.ts`:
- Under the existing dynamic imports add `const { DEFAULT_MACROS } = await import("../../src/macros")`.
- Change the three `formatItemsSummary(BREAKFAST)` / `formatItemsSummary(LUNCH)` calls to pass `DEFAULT_MACROS` as the second argument.
- Change `function keyboardLabels(totals: { calories: number; protein: number }): string[][]` to `function keyboardLabels(totals: ReturnType<typeof sumTotals>): string[][]`.

- [ ] **Step 5: Rewrite totals fixtures in the bot and job tests**

Each of these files gets `import { zeroTotals } from "<relative path>/macros"`, and every totals literal `{ calories: X, protein: Y }` becomes `{ ...zeroTotals(), calories: X, protein: Y }`. No expected string changes.

- `src/bot/commands/today.test.ts` (path `../../macros`): the three `totals:` values.
- `src/bot/commands/stats.test.ts` (path `../../macros`): every day value in both `dailyTotals` objects. Also change `Record<string, { calories: number; protein: number }>` to `Record<string, Totals>`, importing `type Totals` from `../../macros`.
- `src/jobs/reminders.test.ts` (path `../macros`): the totals argument of each `formatReminderMessage` call.
- `src/bot/commands/log.test.ts` (path `../../macros`): the three `totals:` literals.
- `src/bot/conversations/log-flow.test.ts` (path `../../macros`): `totals: { calories: 200, protein: 25 }` in `"confirmation is an HTML summary with a confirm token"`.

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

Run the scripts typecheck (Global Constraints).
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add src scripts
git commit -m "refactor(format): formatters take the macros to show" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Estimates, parsing and the cache check follow the registry

**Files:**
- Modify: `src/ai/types.ts` (`FoodEstimate`), `src/ai/parse.ts` (`coerceProtein` → `coerceGrams`, `normalizeItems`), `src/ai/prompt.ts` (`PROTEIN_RULE` → `MACRO_RULES`), `src/ai/providers/openai.ts` (instructions, `ESTIMATE_SCHEMA`), `src/ai/service.ts` (`isCurrentShape`), `src/bot/commands/edit.ts` (re-estimate copies every macro)
- Test: `src/ai/parse.test.ts`, `src/ai/service.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MAX_GRAMS`, `MacroColumn`, `MacroValues`, `emptyMacroValues`, `macroValuesOf` (Task 1).
- Produces:
  - `type FoodEstimate = { description: string; calories: number; emoji?: string } & Record<MacroColumn, number | null>`
  - `coerceGrams(value: unknown): number | null`: rounds, clamps at 0, returns null above 1000.
  - `MACRO_RULES: string` (registry `rule` lines joined by `\n`), exported from `src/ai/prompt.ts`. With protein only, it equals the old `PROTEIN_RULE`, so every prompt is byte-identical.
  - `isCurrentShape(result)`: false unless `items` is an array and every item has a finite number for every registry column.
  - Task 5 still uses `alignProteinBatch` until it replaces it; this task only switches it to call `coerceGrams`.

- [ ] **Step 1: Write the failing tests**

In `src/ai/parse.test.ts`:

1. Replace the import with:

```ts
import { coerceGrams, normalizeItems, stripFences, alignProteinBatch } from "./parse"
import { MACROS, emptyMacroValues } from "../macros"
```

2. Rename `describe("coerceProtein"` to `describe("coerceGrams"` and every `coerceProtein(` call to `coerceGrams(`. Add to that describe:

```ts
  test("drops values above 1000 g, which are garbage rather than food", () => {
    expect(coerceGrams(1000)).toBe(1000)
    expect(coerceGrams(1001)).toBeNull()
    expect(coerceGrams("5000")).toBeNull()
  })
```

3. In `describe("normalizeItems")`, rewrite the expectations of the first and third tests in registry-agnostic form:

```ts
    ).toEqual([
      { ...emptyMacroValues(), description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { ...emptyMacroValues(), description: "Rice", calories: 200 },
    ])
```
and
```ts
    expect(normalizeItems([null, "x", 7, { description: "Rice", calories: 200, protein_g: 4 }])).toEqual([
      { ...emptyMacroValues(), description: "Rice", calories: 200, protein_g: 4 },
    ])
```

Add:

```ts
  test("coerces every registry column", () => {
    const raw = Object.fromEntries(MACROS.map((m, i) => [m.column, `${i + 1}.4`]))
    expect(normalizeItems([{ description: "X", calories: 1, ...raw }])).toEqual([
      { description: "X", calories: 1, ...Object.fromEntries(MACROS.map((m, i) => [m.column, i + 1])) },
    ])
  })
```

In `src/ai/service.test.ts`, change the first import to `import { AIService, isCurrentShape } from "./service"` and add after the `"protein-aware cache"` describe:

```ts
describe("isCurrentShape", () => {
  test("is false when items is not an array", () => {
    expect(isCurrentShape({ items: "x", needsClarification: false, confidence: "high" } as unknown as EstimationResult)).toBe(false)
  })

  test("needs a number for every macro on every item", () => {
    expect(isCurrentShape(ESTIMATE)).toBe(true)
    expect(isCurrentShape({ ...ESTIMATE, items: [{ ...ESTIMATE.items[0], protein_g: null }] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/ai/parse.test.ts src/ai/service.test.ts`
Expected: FAIL. `coerceGrams` is not exported, and `isCurrentShape` throws on a string `items`.

- [ ] **Step 3: Implement**

`src/ai/types.ts`: add `import type { MacroColumn } from "../macros"` at the top and replace the `FoodEstimate` interface with:

```ts
/** One estimated item. Macro columns are whole grams; null when the model gave nothing usable (the backfill fills it later). */
export type FoodEstimate = {
  description: string
  calories: number
  emoji?: string
} & Record<MacroColumn, number | null>
```

`src/ai/parse.ts`:
- Change the import line to `import { ProviderParseError, type AITrace, type FoodEstimate, type TokenUsage } from "./types"` (unchanged) and add `import { MACROS, MAX_GRAMS, type MacroValues } from "../macros"`.
- Replace `coerceProtein` and `normalizeItems` with:

```ts
/** Whole grams, or null when the value is not a finite number (or numeric string) or is above MAX_GRAMS. */
export function coerceGrams(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof num !== "number" || !Number.isFinite(num)) return null
  const grams = Math.max(0, Math.round(num))
  return grams > MAX_GRAMS ? null : grams
}

/** Items from a parsed estimate, every macro column coerced. Non-arrays become []. */
export function normalizeItems(items: unknown): FoodEstimate[] {
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((raw) => ({
      ...(raw as unknown as FoodEstimate),
      ...(Object.fromEntries(MACROS.map((m) => [m.column, coerceGrams(raw[m.column])])) as MacroValues),
    }))
}
```

- In `alignProteinBatch`, change `coerceProtein(` to `coerceGrams(`.

`src/ai/prompt.ts`:
- In the header comment, change "shares only the protein rule" to "shares only MACRO_RULES".
- Add `import { MACROS } from "../macros"` under the header comment.
- Replace `export const PROTEIN_RULE = "- protein_g: estimated grams of protein for the item, as a whole number"` with:

```ts
/** One rule line per macro, in registry order. Both estimate prompts end their rules with it. */
export const MACRO_RULES = MACROS.map((m) => m.rule).join("\n")
```

- In `ESTIMATE_JSON_PROMPT`, change `${PROTEIN_RULE}` to `${MACRO_RULES}`.

`src/ai/providers/openai.ts`:
- Change the prompt import to `import { MACRO_RULES, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"` and add `import { MACROS } from "../../macros"`.
- In `INSTRUCTIONS`, change `${PROTEIN_RULE}` to `${MACRO_RULES}`.
- Above `ESTIMATE_SCHEMA`, add:

```ts
/** `{ protein_g: { type: "number" }, … }` and the column list, for the strict schemas. */
const MACRO_PROPERTIES = Object.fromEntries(MACROS.map((m) => [m.column, { type: "number" }]))
const MACRO_COLUMNS = MACROS.map((m) => m.column)
```

- In `ESTIMATE_SCHEMA`, replace `protein_g: { type: "number" },` with `...MACRO_PROPERTIES,`, and replace `required: ["description", "calories", "protein_g", "emoji"],` with `required: ["description", "calories", ...MACRO_COLUMNS, "emoji"],`.

`src/ai/service.ts`:
- Add `import { MACROS } from "../macros"`.
- Replace `isCurrentShape` (with its comment) by:

```ts
/**
 * A cached result counts only if every item has a number for every macro.
 * Entries written before a macro existed are misses, so the cache heals
 * itself one description at a time instead of needing a wipe or a version key.
 */
export function isCurrentShape(result: EstimationResult): boolean {
  return (
    Array.isArray(result.items) &&
    result.items.every((item) => MACROS.every((m) => typeof item[m.column] === "number" && Number.isFinite(item[m.column])))
  )
}
```

- In `estimateWithProvider`, change the comment "A result with unknown protein is not worth keeping" to "A result with an unknown macro is not worth keeping".

`src/bot/commands/edit.ts`: change the macros import to `import { DEFAULT_MACROS, macroValuesOf } from "../../macros"` and, in the re-estimate branch, replace

```ts
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            protein_g: newItem.protein_g,
            emoji: newItem.emoji,
          })
```
with
```ts
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            ...macroValuesOf(newItem),
            emoji: newItem.emoji,
          })
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean. The provider tests pass unchanged: the prompts are byte-identical and the OpenAI schema still lists `protein_g`.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "refactor(ai): estimates, parsing and the cache check follow the registry" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Backfill every macro

`estimateMacros` replaces `estimateProtein` on every provider and in `AIService`; the repository gains gap-filling queries; the job and the admin command are renamed. One task, because the batch call's only consumer is the backfill.

**Files:**
- Rename: `src/jobs/backfill-protein.ts` → `src/jobs/backfill-macros.ts`; `src/jobs/backfill-protein.test.ts` → `src/jobs/backfill-macros.test.ts`
- Modify: `src/ai/types.ts`, `src/ai/prompt.ts`, `src/ai/parse.ts`, `src/ai/providers/openai.ts`, `src/ai/providers/anthropic.ts`, `src/ai/providers/gemini.ts`, `src/ai/service.ts`, `src/db/repositories/food-logs.ts`, `src/bot/commands/admin.ts`, `scripts/smoke-providers.ts`
- Test: `src/ai/parse.test.ts`, `src/ai/providers/{openai,anthropic,gemini}.test.ts`, `src/ai/service.test.ts`, `src/db/repositories/food-logs.test.ts`, `src/jobs/backfill-macros.test.ts`, `src/bot/commands/admin-backfill.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MacroColumn`, `MacroValues`, `emptyMacroValues` (Task 1); `coerceGrams` (Task 4).
- Produces:
  - `interface MacroBatchResult { values: MacroValues[]; usage: TokenUsage; trace?: AITrace }` and `AIProvider.estimateMacros(descriptions: string[]): Promise<MacroBatchResult>`. `ProteinBatchResult` and `estimateProtein` are gone.
  - `MACRO_BATCH_PROMPT` and `formatBatchInput` (renamed; text and behaviour unchanged until Task 6).
  - `alignMacroBatch(reply: unknown, count: number): MacroValues[]`
  - `AIService.estimateMacros(descriptions, providerName, opts: BatchOptions): Promise<MacroValues[]>`, where `BatchOptions = { telegramId: number; chatId: number | null }`.
  - `FoodLogsRepository.listDescriptionsMissingMacros(): string[]`, `countItemsMissingMacros(): number`, `fillMissingMacros(description: string, values: Partial<Record<MacroColumn, number>>): number`
  - `runMacroBackfill(deps, opts): Promise<BackfillReport>`; `backfillMacros(deps, adminId, chatId, reply)` in `admin.ts`; subcommand `/admin backfill-macros`.

- [ ] **Step 1: Rename the job and its test with git**

```bash
git mv src/jobs/backfill-protein.ts src/jobs/backfill-macros.ts
git mv src/jobs/backfill-protein.test.ts src/jobs/backfill-macros.test.ts
```

- [ ] **Step 2: Write the failing tests**

**`src/ai/parse.test.ts`.** Change `alignProteinBatch` to `alignMacroBatch` in the import, add `type MacroValues` to the `../macros` import, and replace the `describe("alignProteinBatch", …)` block with:

```ts
describe("alignMacroBatch", () => {
  const v = (partial: Partial<MacroValues>): MacroValues => ({ ...emptyMacroValues(), ...partial })

  test("maps entries back onto inputs by 1-based index, coercing every column", () => {
    const reply = { items: [{ index: 2, protein_g: 4 }, { index: 1, protein_g: 28.2 }] }
    expect(alignMacroBatch(reply, 2)).toEqual([v({ protein_g: 28 }), v({ protein_g: 4 })])
  })

  test("leaves missing and out-of-range indices empty", () => {
    const reply = { items: [{ index: 1, protein_g: 10 }, { index: 5, protein_g: 99 }, { index: "2", protein_g: 3 }] }
    expect(alignMacroBatch(reply, 3)).toEqual([v({ protein_g: 10 }), emptyMacroValues(), emptyMacroValues()])
  })

  test("returns empty rows for garbage", () => {
    expect(alignMacroBatch(null, 2)).toEqual([emptyMacroValues(), emptyMacroValues()])
    expect(alignMacroBatch({ items: "x" }, 2)).toEqual([emptyMacroValues(), emptyMacroValues()])
    expect(alignMacroBatch({ items: [null, 7] }, 1)).toEqual([emptyMacroValues()])
  })
})
```

**Provider tests.** In each of `openai.test.ts`, `anthropic.test.ts` and `gemini.test.ts`:
- `PROTEIN_BATCH_PROMPT` → `MACRO_BATCH_PROMPT` in the import and in the trace assertions.
- Add `import { emptyMacroValues } from "../../macros"`.
- Every `.estimateProtein(` → `.estimateMacros(`.
- Every `result.protein` → `result.values`, with these expectations:
  - `[38, 4]` → `[{ ...emptyMacroValues(), protein_g: 38 }, { ...emptyMacroValues(), protein_g: 4 }]`
  - `[38, null]` (anthropic) → `[{ ...emptyMacroValues(), protein_g: 38 }, emptyMacroValues()]`
  - `[null, 4]` (openai) → `[emptyMacroValues(), { ...emptyMacroValues(), protein_g: 4 }]`
- Rename the describes `"…Provider.estimateProtein"` → `"…Provider.estimateMacros"` and the tests `"the protein batch returns its prompt and raw reply too"` → `"the macro batch returns its prompt and raw reply too"`.
- In `openai.test.ts`, change `expect(calls[0].text.format.name).toBe("protein_batch")` to `.toBe("macro_batch")`.

**`src/ai/service.test.ts`.**
- Add `import { emptyMacroValues, type MacroValues } from "../macros"`.
- In `fakeProvider`, rename `estimateProtein:` to `estimateMacros:`.
- Replace the whole `describe("estimateProtein", …)` block with:

```ts
describe("estimateMacros", () => {
  function batchProvider(values: MacroValues[]): AIProvider {
    return {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => ({ values, usage: OK_RESULT.usage }),
    }
  }

  test("returns the aligned rows and records one backfill row", async () => {
    const rows = [{ ...emptyMacroValues(), protein_g: 38 }, emptyMacroValues()]
    service = build(batchProvider(rows))

    const result = await service.estimateMacros(["Chicken adobo", "Mystery"], "openai", { telegramId: 7, chatId: null })

    expect(result).toEqual(rows)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ telegramId: 7, chatId: null, callType: "backfill", status: "ok" })
  })

  test("never touches the cache", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(batchProvider([{ ...emptyMacroValues(), protein_g: 1 }]))

    await service.estimateMacros(["Chicken adobo"], "openai", { telegramId: 7, chatId: null })

    expect(cache.store.size).toBe(1)
    expect(usage.rows).toHaveLength(1)
  })

  test("records parse_error on a SyntaxError and rethrows", async () => {
    const broken: AIProvider = {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => {
        throw new SyntaxError("Unexpected token")
      },
    }
    service = build(broken)

    await expect(service.estimateMacros(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()
    expect(usage.rows[0]).toMatchObject({ callType: "backfill", status: "parse_error" })
  })
})
```

- In `describe("error reporting")`, rename `"a failed protein batch is reported with call type backfill"` to `"a failed macro batch is reported with call type backfill"`, its `estimateProtein:` to `estimateMacros:`, and `service.estimateProtein(` to `service.estimateMacros(`.
- In `describe("$ai_generation")`, rename `"a protein batch sends one generation with call type backfill"` to `"a macro batch sends one generation with call type backfill"`; make its provider `estimateMacros: async () => ({ values: [{ ...emptyMacroValues(), protein_g: 4 }], usage: OK_RESULT.usage, trace: TRACE })` and its call `service.estimateMacros(["Rice"], …)`.

**`src/db/repositories/food-logs.test.ts`.** Replace the `describe("backfill queries", …)` block with:

```ts
  describe("backfill queries", () => {
    /** Every macro known, so the item has no gap. */
    const complete = Object.fromEntries(MACROS.map((m) => [m.column, 12]))

    test("lists distinct descriptions with any macro missing, in order", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Apple", calories: 95 },
        { description: "Ramen", calories: 540 },
        { description: "Eggs", calories: 180, ...complete },
      ])
      expect(repo.listDescriptionsMissingMacros()).toEqual(["Apple", "Ramen"])
      expect(repo.countItemsMissingMacros()).toBe(3)
    })

    test("fillMissingMacros fills only null cells of rows with that exact description", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Ramen", calories: 540 },
        { description: "ramen", calories: 500 },
        { description: "Ramen", calories: 600, protein_g: 30 },
      ])

      expect(repo.fillMissingMacros("Ramen", { protein_g: 22 })).toBe(2)

      const items = repo.getItemsByDate(1, "2026-09-25")
      expect(items.map((i) => i.protein_g)).toEqual([22, 22, null, 30])
    })

    test("fillMissingMacros with no values changes nothing", () => {
      repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520 }])
      expect(repo.fillMissingMacros("Ramen", {})).toBe(0)
    })
  })
```

**`src/jobs/backfill-macros.test.ts`.** Replace the whole file with:

```ts
// src/jobs/backfill-macros.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { MACROS, emptyMacroValues, type MacroValues } from "../macros"
import { chunk, runMacroBackfill } from "./backfill-macros"
import { FakeAnalytics } from "../analytics/test-helpers"

let foodLogsRepo: FoodLogsRepository
let db: any

beforeEach(() => {
  db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  db.run("INSERT INTO users (telegram_id) VALUES (1)")
})

const OPTS = { providerName: "gemini", telegramId: 1, chatId: null, pauseMs: 0 }

/** A reply row with every macro at `grams`. */
const all = (grams: number): MacroValues => ({
  ...emptyMacroValues(),
  ...Object.fromEntries(MACROS.map((m) => [m.column, grams])),
})

describe("chunk", () => {
  test("splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })

  test("treats a size below 1 as 1 instead of looping forever", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]])
    expect(chunk([1, 2], -5)).toEqual([[1], [2]])
  })
})

describe("runMacroBackfill", () => {
  test("fills only missing values, matching by exact description", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
      { description: "Eggs", calories: 180, ...all(12) },
    ])
    const estimateMacros = mock(async (descriptions: string[]) => descriptions.map((d) => all(d === "Rice" ? 4 : 38)))

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(estimateMacros).toHaveBeenCalledTimes(1)
    expect(estimateMacros).toHaveBeenCalledWith(["Chicken adobo", "Rice"], "gemini", { telegramId: 1, chatId: null })
    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 3, unresolved: 0 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25").map((i) => i.protein_g)).toEqual([38, 38, 4, 12])
  })

  test("never overwrites a value that is already there", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Ramen", calories: 520, protein_g: 30 }])
    const estimateMacros = mock(async (descriptions: string[]) => descriptions.map(() => all(5)))

    await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25")[0].protein_g).toBe(30)
  })

  test("counts a description whose reply lacks a value as unresolved", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Mystery", calories: 100 },
      { description: "Rice", calories: 200 },
    ])
    const estimateMacros = mock(async (descriptions: string[]) =>
      descriptions.map((d) => (d === "Mystery" ? emptyMacroValues() : all(4)))
    )

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.listDescriptionsMissingMacros()).toEqual(["Mystery"])
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
    const estimateMacros = mock(async (descriptions: string[]) => {
      call++
      if (call === 2) throw new Error("503")
      return descriptions.map(() => all(10))
    })

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, { ...OPTS, chunkSize: 2 })

    expect(estimateMacros).toHaveBeenCalledTimes(3)
    expect(report).toEqual({ descriptions: 5, calls: 3, itemsFilled: 3, unresolved: 2 })
    expect(foodLogsRepo.listDescriptionsMissingMacros()).toEqual(["C", "D"])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("makes no calls when nothing is missing", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Eggs", calories: 180, ...all(12) }])
    const estimateMacros = mock(async () => [] as MacroValues[])

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(estimateMacros).not.toHaveBeenCalled()
    expect(report).toEqual({ descriptions: 0, calls: 0, itemsFilled: 0, unresolved: 0 })
  })
})

describe("runMacroBackfill error reporting", () => {
  test("a failed chunk is reported and the run carries on", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const error = new Error("timeout")
    const analytics = new FakeAnalytics()
    const errorLog = spyOn(console, "error").mockImplementation(() => {})

    const report = await runMacroBackfill(
      { foodLogsRepo, aiService: { estimateMacros: mock(() => Promise.reject(error)) } as any, analytics },
      OPTS
    )

    expect(report.unresolved).toBe(1)
    expect(analytics.exceptions).toEqual([{ error, telegramId: 1, properties: { source: "backfill", chunk: 1, chunks: 1 } }])
    errorLog.mockRestore()
  })
})
```

**`src/bot/commands/admin-backfill.test.ts`.** Replace the whole file with:

```ts
// src/bot/commands/admin-backfill.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import { MACROS, emptyMacroValues, type MacroValues } from "../../macros"
import { backfillMacros } from "./admin"
import { FakeAnalytics } from "../../analytics/test-helpers"

const ADMIN = 7

let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let replies: string[]
const reply = async (text: string) => {
  replies.push(text)
}

/** A reply row with every macro at `grams`. */
const all = (grams: number): MacroValues => ({
  ...emptyMacroValues(),
  ...Object.fromEntries(MACROS.map((m) => [m.column, grams])),
})

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(ADMIN, "admin")
  replies = []
})

function fakeAi(values: (descriptions: string[]) => MacroValues[], providers = ["gemini"]) {
  return {
    estimateMacros: mock(async (descriptions: string[]) => values(descriptions)),
    getAvailableProviders: () => providers,
    hasProvider: (name: string) => providers.includes(name),
  } as unknown as AIService
}

describe("backfillMacros", () => {
  test("reports the plan, runs, and reports the result", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
    ])
    const aiService = fakeAi(() => [all(38), all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual([
      "Backfilling macros for 3 items across 2 descriptions (1 AI calls)…",
      "Done. Filled 3 items.",
    ])
  })

  test("mentions unresolved descriptions and how to retry", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Mystery", calories: 100 }, { description: "Rice", calories: 200 }])
    const aiService = fakeAi((d) => d.map((x) => (x === "Mystery" ? emptyMacroValues() : all(4))))

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[1]).toBe("Done. Filled 1 items. 1 descriptions unresolved — run again to retry.")
  })

  test("says so when nothing is missing", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Eggs", calories: 180, ...all(12) }])
    const aiService = fakeAi(() => [])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["Nothing to backfill — every item has all its macros."])
    expect((aiService.estimateMacros as ReturnType<typeof mock>).mock.calls).toHaveLength(0)
  })

  test("refuses when no provider is configured", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [], [])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["No AI provider configured."])
  })

  test("uses the admin's provider and attributes usage to the admin", async () => {
    usersRepo.updateSettings(ADMIN, { ai_provider: "anthropic" })
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [all(4)], ["gemini", "anthropic"])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 99, reply)

    expect(aiService.estimateMacros).toHaveBeenCalledWith(["Rice"], "anthropic", { telegramId: ADMIN, chatId: 99 })
  })

  test("reports a failure instead of going silent", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.fillMissingMacros = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[0]).toStartWith("Backfilling macros for 1 items")
    expect(replies[1]).toBe("Backfill failed: disk full. Nothing was lost — run /admin backfill-macros again to retry.")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("refuses to start a second run while one is in flight", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    let release!: (v: MacroValues[]) => void
    const gate = new Promise<MacroValues[]>((r) => (release = r))
    const aiService = {
      estimateMacros: mock(() => gate),
      getAvailableProviders: () => ["gemini"],
      hasProvider: (name: string) => name === "gemini",
    } as unknown as AIService

    const first = backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2).toEqual(["A backfill is already running — wait for its Done message."])

    release([all(4)])
    await first

    expect(replies[replies.length - 1]).toBe("Done. Filled 1 items.")
  })

  test("clears the running flag after a failure", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.fillMissingMacros = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2[0]).not.toBe("A backfill is already running — wait for its Done message.")
    errorSpy.mockRestore()
  })
})

describe("backfillMacros error reporting", () => {
  test("a failed run is reported as well as told to the admin", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("SQLITE_BUSY")
    let calls = 0
    // Plans fine, then fails when the run itself reads the list again.
    const brokenRepo = {
      listDescriptionsMissingMacros: () => {
        if (calls++ > 0) throw error
        return ["Rice"]
      },
      countItemsMissingMacros: () => 1,
    } as unknown as FoodLogsRepository
    const analytics = new FakeAnalytics()

    await backfillMacros({ foodLogsRepo: brokenRepo, usersRepo, aiService: fakeAi(() => [all(4)]), analytics }, ADMIN, 1, reply)

    expect(replies.at(-1)).toStartWith("Backfill failed: SQLITE_BUSY")
    expect(analytics.exceptions).toEqual([{ error, telegramId: ADMIN, properties: { source: "backfill" } }])
    errorLog.mockRestore()
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test src/ai src/jobs src/bot/commands/admin-backfill.test.ts src/db/repositories/food-logs.test.ts`
Expected: FAIL. `alignMacroBatch`, `estimateMacros`, `runMacroBackfill`, `backfillMacros` and the new repository methods do not exist yet.

- [ ] **Step 4: Types, prompt and parse**

`src/ai/types.ts`:
- Change the macros import to `import type { MacroColumn, MacroValues } from "../macros"`.
- In `AIProvider`, replace the `estimateProtein` member (and its comment) with:

```ts
  /** Every macro for many descriptions in one call; the caller chunks. */
  estimateMacros(descriptions: string[]): Promise<MacroBatchResult>
```

- Replace the `ProteinBatchResult` interface with:

```ts
export interface MacroBatchResult {
  /** Aligned with the input array; a value is null where the model gave nothing usable. */
  values: MacroValues[]
  usage: TokenUsage
  trace?: AITrace
}
```

`src/ai/prompt.ts`: rename `PROTEIN_BATCH_PROMPT` to `MACRO_BATCH_PROMPT` and `formatProteinBatchInput` to `formatBatchInput`. Leave their text and behaviour alone; Task 6 rewrites the prompt.

`src/ai/parse.ts`: add `emptyMacroValues` to the `../macros` import and replace `alignProteinBatch` (with its comment) by:

```ts
/**
 * Maps a batch reply `{items:[{index, protein_g, …}]}` back onto the inputs by
 * 1-based index. Anything missing, malformed or out of range stays null, which
 * the backfill reports as unresolved.
 */
export function alignMacroBatch(reply: unknown, count: number): MacroValues[] {
  const out = Array.from({ length: count }, emptyMacroValues)
  const items = (reply as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return out
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue
    const raw = entry as Record<string, unknown>
    const index = raw.index
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > count) continue
    out[index - 1] = Object.fromEntries(MACROS.map((m) => [m.column, coerceGrams(raw[m.column])])) as MacroValues
  }
  return out
}
```

- [ ] **Step 5: Providers**

`src/ai/providers/openai.ts`:
- Imports: `import { AIProvider, ProviderResult, MacroBatchResult, TokenUsage } from "../types"`, `import { MACRO_RULES, MACRO_BATCH_PROMPT, formatBatchInput } from "../prompt"`, `import { normalizeItems, alignMacroBatch, parseReply, traceOf } from "../parse"`.
- Replace `PROTEIN_BATCH_SCHEMA` with:

```ts
const MACRO_BATCH_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          ...MACRO_PROPERTIES,
        },
        required: ["index", ...MACRO_COLUMNS],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const
```

- Replace `estimateProtein` with:

```ts
  async estimateMacros(descriptions: string[]): Promise<MacroBatchResult> {
    const userMessage = formatBatchInput(descriptions)
    const response = await this.client.responses.create({
      model: MODEL,
      instructions: MACRO_BATCH_PROMPT,
      input: userMessage,
      reasoning: { effort: "none" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "macro_batch",
          schema: MACRO_BATCH_SCHEMA,
          strict: true,
        },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    const usage = usageFrom(response)
    const trace = traceOf(MACRO_BATCH_PROMPT, userMessage, content)
    return {
      values: alignMacroBatch(parseReply(content, usage, trace), descriptions.length),
      usage,
      trace,
    }
  }
```

`src/ai/providers/anthropic.ts`:
- Imports: `ProteinBatchResult` → `MacroBatchResult`; `PROTEIN_BATCH_PROMPT, formatProteinBatchInput` → `MACRO_BATCH_PROMPT, formatBatchInput`; `alignProteinBatch` → `alignMacroBatch`.
- Replace `estimateProtein` with:

```ts
  async estimateMacros(descriptions: string[]): Promise<MacroBatchResult> {
    const userMessage = formatBatchInput(descriptions)
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: MACRO_BATCH_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })

    const text = firstText(response)
    const usage = usageFrom(response)
    const trace = traceOf(MACRO_BATCH_PROMPT, userMessage, text)
    return {
      values: alignMacroBatch(parseReply(stripFences(text), usage, trace), descriptions.length),
      usage,
      trace,
    }
  }
```

`src/ai/providers/gemini.ts`:
- Same import renames as Anthropic.
- Replace `estimateProtein` with:

```ts
  async estimateMacros(descriptions: string[]): Promise<MacroBatchResult> {
    const userMessage = formatBatchInput(descriptions)
    const { text, usage } = await this.generate(MACRO_BATCH_PROMPT, userMessage)
    const trace = traceOf(MACRO_BATCH_PROMPT, userMessage, text)
    return {
      values: alignMacroBatch(parseReply(stripFences(text), usage, trace), descriptions.length),
      usage,
      trace,
    }
  }
```

- [ ] **Step 6: Service**

In `src/ai/service.ts`:
- Change the types import to `import { AIProvider, EstimationResult, MacroBatchResult, ProviderParseError, type AITrace } from "./types"` and the macros import to `import { MACROS, type MacroValues } from "../macros"`.
- Replace `ProteinOptions` with:

```ts
export interface BatchOptions {
  telegramId: number
  chatId: number | null
}
```

- Replace `estimateProtein` (with its comment) by:

```ts
  /**
   * Every macro for many descriptions in one billed call. No cache: the
   * backfill is the only caller and it only asks about rows with gaps.
   */
  async estimateMacros(descriptions: string[], providerName: string, opts: BatchOptions): Promise<MacroValues[]> {
    const provider = this.resolveProvider(providerName)
    const recordOpts: EstimateOptions = { ...opts, callType: "backfill" }

    let result: MacroBatchResult
    const started = performance.now()
    try {
      result = await provider.estimateMacros(descriptions)
    } catch (error) {
      this.recordFailure(error, provider.name, recordOpts, performance.now() - started)
      throw error
    }

    this.recordSafely(provider.name, result.usage, recordOpts, this.statusFor(result.usage), {
      trace: result.trace,
      latencyMs: performance.now() - started,
    })
    return result.values
  }
```

- [ ] **Step 7: Repository**

In `src/db/repositories/food-logs.ts`, add under `MACRO_SUMS`:

```ts
/** True when any macro on the row is still unknown. */
const ANY_MACRO_MISSING = MACROS.map((m) => `${m.column} IS NULL`).join(" OR ")
```

Replace the whole `// --- Protein backfill ---` section (the three methods) with:

```ts
  // --- Macro backfill -------------------------------------------------------

  /** Distinct descriptions of items with any macro still unknown. */
  listDescriptionsMissingMacros(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT description FROM food_items WHERE ${ANY_MACRO_MISSING} ORDER BY description`)
      .all() as { description: string }[]
    return rows.map((r) => r.description)
  }

  countItemsMissingMacros(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM food_items WHERE ${ANY_MACRO_MISSING}`).get() as { n: number }
    return row.n
  }

  /**
   * Fills the still-null cells of every row with this exact description. Exact
   * match on purpose: it is the string the model was asked about. A value
   * already there (from the original estimate or an /edit) is never
   * overwritten. Returns the rows that gained at least one value.
   */
  fillMissingMacros(description: string, values: Partial<Record<MacroColumn, number>>): number {
    const given = MACROS.filter((m) => typeof values[m.column] === "number")
    if (given.length === 0) return 0
    const set = given.map((m) => `${m.column} = COALESCE(${m.column}, ?)`).join(", ")
    const gap = given.map((m) => `${m.column} IS NULL`).join(" OR ")
    const result = this.db
      .prepare(`UPDATE food_items SET ${set} WHERE description = ? AND (${gap})`)
      .run(...given.map((m) => values[m.column] as number), description)
    return result.changes
  }
```

- [ ] **Step 8: The job**

Replace the contents of `src/jobs/backfill-macros.ts` with:

```ts
// src/jobs/backfill-macros.ts
// Fills every macro still unknown on food items: rows logged before a macro
// existed, and the odd estimate where the model left one out. Sends many
// descriptions per AI call so the system prompt is paid for once per chunk,
// which is where the cost is; a provider batch API would save a similar
// amount at the price of async job tracking (see the protein spec's Decisions).
import type { FoodLogsRepository } from "../db/repositories/food-logs"
import type { AIService } from "../ai/service"
import type { Analytics } from "../analytics"
import { MACROS, type MacroColumn, type MacroValues } from "../macros"

export interface BackfillReport {
  /** Distinct descriptions with a macro missing when the run started. */
  descriptions: number
  /** Chunks attempted, including ones that threw. */
  calls: number
  /** food_items rows that gained at least one value. */
  itemsFilled: number
  /** Descriptions in a failed chunk, or whose reply still lacked a value. */
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
  foodLogsRepo: Pick<FoodLogsRepository, "listDescriptionsMissingMacros" | "fillMissingMacros">
  aiService: Pick<AIService, "estimateMacros">
  analytics?: Analytics
}

export const DEFAULT_CHUNK_SIZE = 25
export const DEFAULT_PAUSE_MS = 500

/**
 * Splits an array into chunks of the given size. Sizes below 1 are treated as 1.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step))
  }
  return out
}

/** The values a reply row actually has. */
function knownValues(row: MacroValues | undefined): Partial<Record<MacroColumn, number>> {
  const known: Partial<Record<MacroColumn, number>> = {}
  for (const m of MACROS) {
    const grams = row?.[m.column]
    if (typeof grams === "number") known[m.column] = grams
  }
  return known
}

/**
 * Only null cells are ever written, so running this twice is safe and a
 * partial failure is retried simply by running it again.
 */
export async function runMacroBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const descriptions = deps.foodLogsRepo.listDescriptionsMissingMacros()
  const chunks = chunk(descriptions, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS
  const report: BackfillReport = { descriptions: descriptions.length, calls: 0, itemsFilled: 0, unresolved: 0 }

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]
    report.calls++

    let values: MacroValues[]
    try {
      values = await deps.aiService.estimateMacros(batch, opts.providerName, {
        telegramId: opts.telegramId,
        chatId: opts.chatId,
      })
    } catch (error) {
      console.error(`[backfill] chunk ${i + 1}/${chunks.length} failed:`, error)
      deps.analytics?.captureException(error, opts.telegramId, { source: "backfill", chunk: i + 1, chunks: chunks.length })
      report.unresolved += batch.length
      continue
    }

    batch.forEach((description, j) => {
      const known = knownValues(values[j])
      report.itemsFilled += deps.foodLogsRepo.fillMissingMacros(description, known)
      if (Object.keys(known).length < MACROS.length) report.unresolved++
    })

    if (pauseMs > 0 && i < chunks.length - 1) {
      await Bun.sleep(pauseMs)
    }
  }

  return report
}
```

- [ ] **Step 9: The admin command**

In `src/bot/commands/admin.ts`:
- Change `import { runProteinBackfill, DEFAULT_CHUNK_SIZE } from "../../jobs/backfill-protein"` to `import { runMacroBackfill, DEFAULT_CHUNK_SIZE } from "../../jobs/backfill-macros"`.
- In the comment above `let backfillRunning`, change `/admin backfill-protein` to `/admin backfill-macros`.
- Replace `backfillProtein` (with its doc comment) by:

```ts
/**
 * /admin backfill-macros. Separated from the command so it can be tested
 * without the admin gate, which reads config.adminUsers from the environment.
 * Usage rows are attributed to the admin who ran it.
 */
export async function backfillMacros(
  deps: Pick<AdminDeps, "foodLogsRepo" | "usersRepo" | "aiService" | "analytics">,
  adminId: number,
  chatId: number | null,
  reply: (text: string) => Promise<void>
): Promise<void> {
  if (backfillRunning) {
    await reply("A backfill is already running — wait for its Done message.")
    return
  }
  backfillRunning = true
  try {
    const descriptions = deps.foodLogsRepo.listDescriptionsMissingMacros()
    if (descriptions.length === 0) {
      await reply("Nothing to backfill — every item has all its macros.")
      return
    }
    if (deps.aiService.getAvailableProviders().length === 0) {
      await reply("No AI provider configured.")
      return
    }

    const items = deps.foodLogsRepo.countItemsMissingMacros()
    const calls = Math.ceil(descriptions.length / DEFAULT_CHUNK_SIZE)
    await reply(`Backfilling macros for ${items} items across ${descriptions.length} descriptions (${calls} AI calls)…`)

    // AIService falls back to the first configured provider if this one is not available.
    const providerName = deps.usersRepo.findById(adminId)?.ai_provider ?? "gemini"
    try {
      const report = await runMacroBackfill(
        { foodLogsRepo: deps.foodLogsRepo, aiService: deps.aiService, analytics: deps.analytics },
        { providerName, telegramId: adminId, chatId }
      )

      let done = `Done. Filled ${report.itemsFilled} items.`
      if (report.unresolved > 0) {
        done += ` ${report.unresolved} descriptions unresolved — run again to retry.`
      }
      await reply(done)
    } catch (error) {
      console.error("[backfill] failed:", error)
      deps.analytics?.captureException(error, adminId, { source: "backfill" })
      await reply(
        `Backfill failed: ${error instanceof Error ? error.message : String(error)}. Nothing was lost — run /admin backfill-macros again to retry.`
      )
    }
  } finally {
    backfillRunning = false
  }
}
```

- In the `/admin` usage text, change `"/admin backfill-protein\n"` to `"/admin backfill-macros\n"`.
- Change `case "backfill-protein": {` to `case "backfill-macros": {` and `void backfillProtein(` to `void backfillMacros(` inside it.
- In the `announce-privacy` case, change the comment `// In the background, like backfill-protein:` to `// In the background, like backfill-macros:`.

- [ ] **Step 10: The smoke script**

Replace `scripts/smoke-providers.ts` with:

```ts
// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
//
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini>           # estimate()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --macros  # estimateMacros()
//
// With POSTHOG_API_KEY and POSTHOG_ID_SECRET set, the call is also sent to
// PostHog as $ai_generation (tagged environment=development unless
// POSTHOG_ENVIRONMENT says otherwise).
import { AIService } from "../src/ai/service"
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"
import { createAnalytics } from "../src/analytics"
import { config } from "../src/config"
import { MACROS } from "../src/macros"

const provider = process.argv[2]
const mode = process.argv[3] === "--macros" ? "macros" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--macros]")
  process.exit(1)
}

const db = createTestDb()
const analytics = createAnalytics(config.posthog)
const service = new AIService(new CacheRepository(db), new UsageRepository(db), analytics)

/** Flushes analytics before exiting, or the $ai_generation event is lost. */
async function finish(code: number): Promise<never> {
  await analytics.shutdown()
  if (config.posthog.apiKey) console.log(`Sent to PostHog (${config.posthog.environment}): check LLM analytics → Generations.`)
  process.exit(code)
}

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
  if (mode === "macros") {
    const descriptions = ["two scrambled eggs", "a slice of toast", "black coffee"]
    const values = await service.estimateMacros(descriptions, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to estimateMacros`)
    descriptions.forEach((d, i) =>
      console.log(`  ${d}: ${MACROS.map((m) => `${values[i][m.column] ?? "?"} g ${m.totalLabel}`).join(", ")}`)
    )
    if (values.some((row) => MACROS.some((m) => row[m.column] === null))) {
      console.error("✗ At least one description came back with a macro missing.")
      await finish(1)
    }
    await finish(0)
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
    await finish(1)
  }
  const missing = result.items.filter((item) => MACROS.some((m) => item[m.column] === null)).length
  if (missing > 0) {
    console.error(`✗ ${missing} item(s) came back with a macro missing.`)
    await finish(1)
  }
  await finish(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  await finish(1)
}
```

- [ ] **Step 11: Run everything and check nothing still uses the old names**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

Run the scripts typecheck (Global Constraints).
Expected: exit 0, no output.

Run:
```bash
grep -rn -E "estimateProtein|ProteinBatchResult|ProteinOptions|PROTEIN_BATCH_PROMPT|formatProteinBatchInput|alignProteinBatch|coerceProtein|runProteinBackfill|backfillProtein|backfill-protein|MissingProtein|setProteinForDescription" src scripts
```
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add -A src scripts
git commit -m "feat(backfill): /admin backfill-macros fills every missing macro" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Fat, fiber and added sugar: estimated and stored, shown to nobody yet

### Task 6: Estimate and store fat, fiber and added sugar

After this task every estimate and every backfill fills four macros, but replies are unchanged because every user still has the default macros. The proof is that every existing reply test passes without edits.

**Files:**
- Modify: `src/macros.ts` (three entries), `src/db/schema.sql`, `src/db/migrations.ts`, `src/ai/prompt.ts` (both prompts, header comment), `src/ai/providers/openai.ts` (first line of `INSTRUCTIONS`)
- Create: `src/ai/prompt.test.ts`
- Test: `src/macros.test.ts`, `src/db/migrations.test.ts`, `src/db/test-helpers.test.ts`, `src/db/repositories/food-logs.test.ts`, `src/utils/format.test.ts`, `src/ai/parse.test.ts`, `src/ai/providers/{openai,anthropic,gemini}.test.ts`, `src/ai/service.test.ts`, `src/db/repositories/cache.test.ts`, `src/jobs/backfill-macros.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `MacroKey = "protein" | "fat" | "fiber" | "added_sugar"`, `MacroColumn = "protein_g" | "fat_g" | "fiber_g" | "added_sugar_g"`. Every registry-driven type, query, schema and prompt rule widens with them.

- [ ] **Step 1: Write the failing tests**

**`src/macros.test.ts`.** Add `getMacro` and `withMacro` to the import if missing, and append:

```ts
describe("fat, fiber and added sugar", () => {
  test("follow protein in this order", () => {
    expect(MACROS.map((m) => m.key)).toEqual(["protein", "fat", "fiber", "added_sugar"])
    expect(MACROS.map((m) => m.column)).toEqual(["protein_g", "fat_g", "fiber_g", "added_sugar_g"])
  })

  test("carry the spec's labels", () => {
    expect(MACROS.map((m) => [m.name, m.itemLabel, m.totalLabel])).toEqual([
      ["Protein", "", "protein"],
      ["Fat", "fat", "fat"],
      ["Fiber", "fiber", "fiber"],
      ["Added sugar", "sugar", "added sugar"],
    ])
  })

  test("are found by their /edit words", () => {
    expect(macroByKeyword("fat")?.key).toBe("fat")
    expect(macroByKeyword("Fibre")?.key).toBe("fiber")
    expect(macroByKeyword("sugar")?.key).toBe("added_sugar")
    expect(macroByKeyword("added  sugar")?.key).toBe("added_sugar")
  })

  test("the added sugar rule says what counts", () => {
    const rule = getMacro("added_sugar").rule
    expect(rule).toContain("added in processing or cooking")
    expect(rule).toContain("whole fruit, vegetables and plain milk counts as 0")
  })

  test("parsing and withMacro keep registry order", () => {
    expect(parseTrackedMacros("added_sugar,protein")).toEqual(["protein", "added_sugar"])
    expect(withMacro(["added_sugar"], "fat")).toEqual(["fat", "added_sugar"])
  })
})
```

**`src/db/migrations.test.ts`.** Add inside `describe("runMigrations")`:

```ts
  test("adds the fat, fiber and added sugar columns, null on existing rows", () => {
    const db = preProteinDb()
    runMigrations(db, undefined, () => {})

    expect(db.prepare("SELECT fat_g, fiber_g, added_sugar_g FROM food_items").get()).toEqual({
      fat_g: null,
      fiber_g: null,
      added_sugar_g: null,
    })
  })
```

**`src/db/test-helpers.test.ts`.** Add `import { MACROS } from "../macros"` and replace the test `"food_items and users carry the protein columns"` with:

```ts
  test("food_items carries every macro column, users the protein goal", () => {
    const db = createTestDb()
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    for (const m of MACROS) expect(names("food_items")).toContain(m.column)
    expect(names("users")).toContain("daily_protein_goal")
  })
```

**`src/db/repositories/food-logs.test.ts`.** Add before `describe("backfill queries"`:

```ts
  test("stores and sums fat, fiber and added sugar", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 },
      { description: "Rice", calories: 205, protein_g: 4, fat_g: 0, fiber_g: 1, added_sugar_g: 0 },
      { description: "Mystery", calories: 50 },
    ])
    const items = repo.getByDate(123, "2026-01-31")[0].items
    expect(items[0]).toMatchObject({ fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
    expect(items[2]).toMatchObject({ fat_g: null, fiber_g: null, added_sugar_g: null })
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 675, protein: 42, fat: 24, fiber: 2, added_sugar: 2 })
  })

  test("updateItem sets one new macro alone", () => {
    const id = repo.create(123, 456, "2026-01-31", [{ description: "Adobo", calories: 420, protein_g: 38 }]).items[0].id!
    repo.updateItem(id, { added_sugar_g: 3 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ protein_g: 38, added_sugar_g: 3, fat_g: null })
  })

  test("fillMissingMacros fills the new columns and leaves protein alone", () => {
    repo.create(1, 100, "2026-09-25", [{ description: "Adobo", calories: 420, protein_g: 38 }])
    expect(repo.listDescriptionsMissingMacros()).toEqual(["Adobo"])

    expect(repo.fillMissingMacros("Adobo", { protein_g: 30, fat_g: 24, fiber_g: 1, added_sugar_g: 2 })).toBe(1)

    expect(repo.getItemsByDate(1, "2026-09-25")[0]).toMatchObject({ protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
    expect(repo.listDescriptionsMissingMacros()).toEqual([])
  })
```

**`src/utils/format.test.ts`.** Append:

```ts
describe("fat, fiber and added sugar", () => {
  const adobo = { description: "Chicken adobo (2 pcs)", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }
  const rice = { description: "Steamed rice (1 cup)", calories: 205, protein_g: 4, fat_g: 0, fiber_g: 1, added_sugar_g: 0, emoji: "🍚" }
  const ALL: MacroKey[] = ["protein", "fat", "fiber", "added_sugar"]

  test("item lines label every macro but protein", () => {
    expect(formatItemLine(adobo, ALL)).toBe("🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 24 g fat · 1 g fiber · 2 g sugar")
    expect(formatItemLine(adobo, ["added_sugar"])).toBe("🍗 Chicken adobo (2 pcs) — 420 cal · 2 g sugar")
  })

  test("unknown values show ? g with their label", () => {
    expect(formatItemLine({ description: "Rice", calories: 200 }, ALL)).toBe("🍽️ Rice — 200 cal · ? g · ? g fat · ? g fiber · ? g sugar")
  })

  test("totals spell out added sugar", () => {
    expect(formatTotals(sumTotals([adobo, rice]), ALL)).toBe("625 cal · 42 g protein · 24 g fat · 2 g fiber · 2 g added sugar")
  })

  test("the order on screen is the registry's, whatever order the list is in", () => {
    expect(formatItemLine(adobo, ["added_sugar", "protein"])).toBe("🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 2 g sugar")
  })

  test("protein only is unchanged", () => {
    expect(formatItemLine(adobo, PROTEIN)).toBe("🍗 Chicken adobo (2 pcs) — 420 cal · 38 g")
    expect(formatTotals(sumTotals([adobo, rice]), PROTEIN)).toBe("625 cal · 42 g protein")
  })
})
```

**`src/ai/parse.test.ts`.** Add inside `describe("normalizeItems")`:

```ts
  test("coerces fat, fiber and added sugar", () => {
    expect(
      normalizeItems([{ description: "Adobo", calories: 420, protein_g: 38, fat_g: "24.4", fiber_g: 1.2, added_sugar_g: "lots" }])
    ).toEqual([{ description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: null }])
  })
```

and inside `describe("alignMacroBatch")`:

```ts
  test("keeps the values a row has and nulls the rest", () => {
    const reply = { items: [{ index: 1, protein_g: 14, fat_g: 10, fiber_g: 0 }] }
    expect(alignMacroBatch(reply, 1)).toEqual([{ protein_g: 14, fat_g: 10, fiber_g: 0, added_sugar_g: null }])
  })
```

**`src/ai/prompt.test.ts`.** Create it:

```ts
// src/ai/prompt.test.ts
import { describe, test, expect } from "bun:test"
import { MACROS } from "../macros"
import { ESTIMATE_JSON_PROMPT, MACRO_BATCH_PROMPT, MACRO_RULES } from "./prompt"

describe("prompts", () => {
  test("MACRO_RULES is every registry rule, in order", () => {
    expect(MACRO_RULES).toBe(MACROS.map((m) => m.rule).join("\n"))
  })

  test("the estimate prompt asks for every macro and shows each in its example", () => {
    expect(ESTIMATE_JSON_PROMPT).toStartWith(
      "You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food."
    )
    expect(ESTIMATE_JSON_PROMPT).toContain("{description, calories, protein_g, fat_g, fiber_g, added_sugar_g, emoji}")
    expect(ESTIMATE_JSON_PROMPT).toContain(MACRO_RULES)
    for (const m of MACROS) expect(ESTIMATE_JSON_PROMPT).toContain(`"${m.column}":`)
  })

  test("the batch prompt asks for every macro on every line", () => {
    expect(MACRO_BATCH_PROMPT).toContain(MACRO_RULES)
    for (const m of MACROS) expect(MACRO_BATCH_PROMPT).toContain(`"${m.column}":`)
  })
})
```

**Provider tests.** Each of the three files gets `MACROS` added to its `../../macros` import.

In `openai.test.ts`, replace the test `"requires protein_g in the strict schema"` with:

```ts
  test("requires every macro in the strict schema", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    const itemSchema = calls[0].text.format.schema.properties.items.items
    for (const m of MACROS) {
      expect(itemSchema.properties[m.column]).toEqual({ type: "number" })
      expect(itemSchema.required).toContain(m.column)
    }
  })
```

replace `"mentions protein in the instructions"` with:

```ts
  test("asks for every macro in the instructions", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")
    expect(calls[0].instructions).toStartWith(
      "You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food."
    )
    for (const m of MACROS) expect(calls[0].instructions).toContain(m.column)
  })
```

and add to `describe("OpenAIProvider.estimateMacros")`:

```ts
  test("the batch schema requires every macro", async () => {
    const { client, calls } = fakeClient(BATCH_REPLY)
    await new OpenAIProvider(client).estimateMacros(["Rice"])

    const entry = calls[0].text.format.schema.properties.items.items
    for (const m of MACROS) {
      expect(entry.properties[m.column]).toEqual({ type: "number" })
      expect(entry.required).toContain(m.column)
    }
  })
```

In `gemini.test.ts`, change the last line of `"asks for protein_g in the system instruction"` to `for (const m of MACROS) expect(seen[0].systemInstruction).toContain(m.column)` and rename the test `"asks for every macro in the system instruction"`. In `anthropic.test.ts`, do the same to `"asks for protein_g in the system prompt"`: its last line becomes `for (const m of MACROS) expect(calls[0].system).toContain(m.column)`, and its name `"asks for every macro in the system prompt"`.

**`src/ai/service.test.ts`.**
- Change `ESTIMATE` to carry every macro (a cache hit needs all four):

```ts
const ESTIMATE: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }],
  needsClarification: false,
  confidence: "high",
}
```

- Rename `describe("protein-aware cache"` to `describe("macro-aware cache"`. In its test `"does not cache a result with unknown protein"`, change the item to `{ ...emptyMacroValues(), description: "Mystery", calories: 100 }`. Add:

```ts
  test("treats a cached result missing a newer macro as a miss", async () => {
    const { added_sugar_g, ...withoutSugar } = ESTIMATE.items[0]
    cache.set("chicken adobo", { ...ESTIMATE, items: [withoutSugar] } as unknown as EstimationResult)
    service = build(fakeProvider(OK_RESULT))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows).toHaveLength(1)
    expect(cache.store.get("chicken adobo")).toEqual(ESTIMATE)
  })
```

**`src/db/repositories/cache.test.ts`.** Add `import { emptyMacroValues } from "../../macros"`. Change `RESULT`'s item to `{ description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }` and the overwrite item to `{ ...emptyMacroValues(), description: "Adobo", calories: 500, protein_g: 40 }`.

**`src/jobs/backfill-macros.test.ts`.** Add inside `describe("runMacroBackfill")`:

```ts
  test("a reply row with only some values fills those and stays unresolved", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const estimateMacros = mock(async () => [{ ...emptyMacroValues(), protein_g: 4, fiber_g: 1 }])

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(report).toEqual({ descriptions: 1, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25")[0]).toMatchObject({ protein_g: 4, fiber_g: 1, fat_g: null, added_sugar_g: null })
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test`
Expected: FAIL in the new tests only (the registry has one entry, the columns and prompt text do not exist). Every pre-existing reply test still passes.

- [ ] **Step 3: Add the three registry entries**

In `src/macros.ts`, add after the protein entry, inside `MACROS`:

```ts
  {
    key: "fat",
    column: "fat_g",
    name: "Fat",
    itemLabel: "fat",
    totalLabel: "fat",
    keywords: ["fat"],
    rule: "- fat_g: estimated grams of total fat for the item, as a whole number",
  },
  {
    key: "fiber",
    column: "fiber_g",
    name: "Fiber",
    itemLabel: "fiber",
    totalLabel: "fiber",
    keywords: ["fiber", "fibre"],
    rule: "- fiber_g: estimated grams of dietary fiber for the item, as a whole number",
  },
  {
    key: "added_sugar",
    column: "added_sugar_g",
    name: "Added sugar",
    // "sugar" on item lines to save width; totals spell out "added sugar".
    itemLabel: "sugar",
    totalLabel: "added sugar",
    keywords: ["sugar", "added sugar"],
    rule:
      "- added_sugar_g: estimated grams of added sugar for the item, as a whole number. " +
      "Count sugar, syrups, honey and other sweeteners added in processing or cooking, including in sauces, drinks and desserts. " +
      "Sugar that occurs naturally in whole fruit, vegetables and plain milk counts as 0",
  },
```

- [ ] **Step 4: Columns and migrations**

In `src/db/schema.sql`, in `CREATE TABLE IF NOT EXISTS food_items`, add under the `protein_g` line:

```sql
  fat_g INTEGER,                -- whole grams; null = not yet estimated
  fiber_g INTEGER,              -- whole grams; null = not yet estimated
  added_sugar_g INTEGER,        -- whole grams; null = not yet estimated
```

In `src/db/migrations.ts`, append to `COLUMN_MIGRATIONS`:

```ts
  { table: "food_items", column: "fat_g", ddl: "INTEGER" },
  { table: "food_items", column: "fiber_g", ddl: "INTEGER" },
  { table: "food_items", column: "added_sugar_g", ddl: "INTEGER" },
```

- [ ] **Step 5: Prompts**

In `src/ai/prompt.ts`, replace the header comment with:

```ts
// src/ai/prompt.ts
// Prompt text shared across providers. Anthropic and Gemini ask for JSON in
// prose; OpenAI's strict schema carries the shape, so it keeps its own shorter
// instructions and shares only MACRO_RULES. A macro added to src/macros.ts
// joins MACRO_RULES by itself, but the shape lines and worked examples below
// are prose and are updated by hand (prompt.test.ts fails until they are).
```

Replace `ESTIMATE_JSON_PROMPT` with:

```ts
export const ESTIMATE_JSON_PROMPT = `You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food.

When given a food description, respond with ONLY a JSON object (no markdown, no explanation) containing:
- items: array of {description, calories, protein_g, fat_g, fiber_g, added_sugar_g, emoji} for each food item
- needsClarification: boolean - true if the description is too vague
- clarificationQuestion: string - question to ask if clarification needed
- confidence: "high" | "medium" | "low"

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include relevant emoji for each food item
- If multiple items mentioned, break them down separately
- If quantity/size is unclear, ask for clarification
${MACRO_RULES}

Example input: "chicken sandwich and fries"
Example output:
{"items":[{"description":"Chicken sandwich","calories":450,"protein_g":28,"fat_g":18,"fiber_g":2,"added_sugar_g":4,"emoji":"🥪"},{"description":"French fries (medium)","calories":365,"protein_g":4,"fat_g":17,"fiber_g":4,"added_sugar_g":0,"emoji":"🍟"}],"needsClarification":false,"confidence":"medium"}`
```

Replace `MACRO_BATCH_PROMPT` with:

```ts
export const MACRO_BATCH_PROMPT = `You are a nutrition expert. You will receive a numbered list of food descriptions, one per line, in the form "1. <description>".

For each line, estimate the grams of protein, total fat, dietary fiber and added sugar, using common portion sizes when none is given.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"items":[{"index":1,"protein_g":14,"fat_g":10,"fiber_g":0,"added_sugar_g":0},{"index":2,"protein_g":0,"fat_g":0,"fiber_g":0,"added_sugar_g":0}]}

Rules:
- Return exactly one entry per input line, using that line's number as index
${MACRO_RULES}
- Never skip a line; if unsure, give your best estimate`
```

In `src/ai/providers/openai.ts`, change the first line of `INSTRUCTIONS` from `You are a nutrition expert that estimates calories and protein in food.` to `You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food.`

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

Confirm the replies did not move: `git diff --stat HEAD -- src/bot src/jobs/reminders.test.ts src/jobs/retry-pending.test.ts` must list no test file under `src/bot` or those two job tests (none were edited in this task).

Run the scripts typecheck (Global Constraints).
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat(macros): estimate and store fat, fiber and added sugar" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Each user picks their macros

### Task 7: `users.tracked_macros`

**Files:**
- Modify: `src/db/schema.sql` (users), `src/db/migrations.ts`, `src/db/repositories/users.ts`
- Test: `src/db/repositories/users.test.ts`, `src/db/migrations.test.ts`, `src/db/test-helpers.test.ts`

**Interfaces:**
- Consumes: `parseTrackedMacros`, `serializeTrackedMacros`, `MacroKey` (Task 1).
- Produces: `User.tracked_macros: MacroKey[]` (registry order, from every read: `upsert`, `findById`, `getUsersWithReminders`); `updateSettings(id, { tracked_macros: readonly MacroKey[] })`.

- [ ] **Step 1: Write the failing tests**

**`src/db/repositories/users.test.ts`.** Move the first describe onto the real schema: replace its `beforeEach` with

```ts
  beforeEach(() => {
    db = createTestDb()
    repo = new UsersRepository(db)
  })
```

and in `"creates a new user"` change `expect(user.ai_provider).toBe("openai")` to `expect(user.ai_provider).toBe("gemini")`. The old hand-written table defaulted to `openai`; `schema.sql` defaults to `gemini`.

Append:

```ts
describe("UsersRepository tracked_macros", () => {
  test("a new user tracks protein only", () => {
    const repo = new UsersRepository(createTestDb())
    expect(repo.upsert(123, "john").tracked_macros).toEqual(["protein"])
  })

  test("round-trips in registry order, including none", () => {
    const repo = new UsersRepository(createTestDb())
    repo.upsert(123, "john")

    repo.updateSettings(123, { tracked_macros: ["added_sugar", "protein"] })
    expect(repo.findById(123)!.tracked_macros).toEqual(["protein", "added_sugar"])

    repo.updateSettings(123, { tracked_macros: [] })
    expect(repo.findById(123)!.tracked_macros).toEqual([])
  })

  test("getUsersWithReminders carries them too", () => {
    const repo = new UsersRepository(createTestDb())
    repo.upsert(123, "john")
    repo.updateSettings(123, { reminder_time: "20:00", tracked_macros: ["fiber"] })
    expect(repo.getUsersWithReminders()[0].tracked_macros).toEqual(["fiber"])
  })
})
```

**`src/db/migrations.test.ts`.** Add:

```ts
  test("adds users.tracked_macros, protein for existing users", () => {
    const db = preProteinDb()
    runMigrations(db, undefined, () => {})

    expect(db.prepare("SELECT tracked_macros FROM users").get()).toEqual({ tracked_macros: "protein" })
  })
```

**`src/db/test-helpers.test.ts`.** In `"food_items carries every macro column, users the protein goal"`, add `expect(names("users")).toContain("tracked_macros")`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/db`
Expected: FAIL: `tracked_macros` is undefined and the column does not exist.

- [ ] **Step 3: Implement**

`src/db/schema.sql`, in `CREATE TABLE IF NOT EXISTS users`, after the `analytics_content` line:

```sql
  -- comma list of macro keys shown beside calories (/settings → Macros); '' = none
  tracked_macros TEXT DEFAULT 'protein',
```

`src/db/migrations.ts`, append to `COLUMN_MIGRATIONS`:

```ts
  { table: "users", column: "tracked_macros", ddl: "TEXT DEFAULT 'protein'" },
```

`src/db/repositories/users.ts`:
- Add `import { parseTrackedMacros, serializeTrackedMacros, type MacroKey } from "../../macros"`.
- In `User`, before `created_at`, add:

```ts
  /** Macros shown beside calories, in registry order (/settings → Macros). */
  tracked_macros: MacroKey[]
```

- In `UserRow`, before `created_at`, add `tracked_macros: string | null`.
- In `updateSettings`, add `tracked_macros: readonly MacroKey[]` to the settings type, add `"tracked_macros"` to `allowedColumns`, and add before `if (columnUpdates.length === 0) return`:

```ts
    if (settings.tracked_macros !== undefined) {
      columnUpdates.push({ column: "tracked_macros", value: serializeTrackedMacros(settings.tracked_macros) })
    }
```

- In `rowToUser`, add `tracked_macros: parseTrackedMacros(row.tracked_macros),` after the `analytics_content` line.

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(db): users.tracked_macros, protein by default" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The log card, `/delete` and retried entries follow the user's macros

**Files:**
- Modify: `src/bot/conversations/log-flow.ts`, `src/bot/commands/log.ts`, `src/bot/commands/delete.ts`, `src/jobs/retry-pending.ts`, `src/bot/index.ts`, `scripts/telegram-mock/render.ts`
- Test: `src/bot/conversations/log-flow.test.ts`, `src/bot/commands/log.test.ts`, `src/bot/commands/delete.test.ts`, `src/jobs/retry-pending.test.ts`

**Interfaces:**
- Consumes: `User.tracked_macros` (Task 7); `DEFAULT_MACROS`, `MacroKey`, `Totals` (Task 1); the formatters (Task 3).
- Produces:
  - `new LogFlow(conversations, foodLogs, pending, aiService, users: Pick<UsersRepository, "findById">)`
  - `LogFlowResult.confirm: { token: string; totals: Totals; macros: MacroKey[] }`
  - `buildLogConfirmKeyboard(ownerId, { token, totals, macros: readonly MacroKey[] })`: the button shows protein only when `macros` includes it.
  - `resolveDeleteCallback(cb, presserId, foodLogsRepo, macros: readonly MacroKey[])`
  - `createDeleteMessageHandler(foodLogsRepo, usersRepo)`, `createDeleteCallbackHandler(foodLogsRepo, usersRepo)`

A user without a row (which the upsert middleware makes unlikely) gets `DEFAULT_MACROS` everywhere.

- [ ] **Step 1: Write the failing tests**

**`src/bot/conversations/log-flow.test.ts`.**
- Add `import { UsersRepository } from "../../db/repositories/users"` and declare `let usersRepo: UsersRepository` beside the other repositories.
- In `beforeEach`, replace `db.run("INSERT INTO users (telegram_id) VALUES (123)")` with:

```ts
    usersRepo = new UsersRepository(db)
    usersRepo.upsert(123, "maria")
```

- Add `usersRepo` as the fifth argument of `new LogFlow(...)`.
- In `"confirmation is an HTML summary with a confirm token"`, change the `result.confirm` expectation to:

```ts
    expect(result.confirm).toEqual({
      token: confirmToken("2026-01-31", state.pending_items!),
      totals: { ...zeroTotals(), calories: 200, protein: 25 },
      macros: ["protein"],
    })
```

- Append:

```ts
  test("the card, its totals and the typed-yes reply follow the user's macros", async () => {
    usersRepo.updateSettings(123, { tracked_macros: ["protein", "added_sugar"] })
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "adobo", "openai")

    expect(result.message).toBe(
      "Here's what I'll log for Sat, Jan 31:\n\n<blockquote>🍗 Chicken adobo — 420 cal · 38 g · 2 g sugar</blockquote>\n\n" +
        "<b>Total: 420 cal · 38 g protein · 2 g added sugar</b>"
    )
    expect(result.confirm?.macros).toEqual(["protein", "added_sugar"])

    const logged = await logFlow.processInput(123, 456, "yes", "openai")
    expect(logged.message).toBe("Logged 420 cal · 38 g protein · 2 g added sugar for Sat, Jan 31.")
  })

  test("with no macros the logged card shows calories only", async () => {
    usersRepo.updateSettings(123, { tracked_macros: [] })
    const token = await reachConfirming()

    expect(logFlow.resolveConfirmation(123, 456, token, "log")).toEqual({
      stale: false,
      edit: "✅ Logged to Sat, Jan 31:\n\n<blockquote>🍗 Chicken — 200 cal</blockquote>\n\n<b>Total: 200 cal</b>",
      toast: "Logged ✅",
    })
  })
```

**`src/bot/commands/log.test.ts`.**
- Add `macros: ["protein"]` to the `confirm` object returned by `startWithFood` in `commandDeps` and to the `buildLogConfirmKeyboard(42, …)` call in the same test's expectation, and to the call in `"puts Log full-width above Change and Cancel, with both totals on the button"`. Expected labels stay the same.
- Add inside `describe("buildLogConfirmKeyboard")`:

```ts
  test("leaves protein off the button when the user doesn't track it", () => {
    const keyboard = buildLogConfirmKeyboard(42, {
      token: "abcd1234",
      totals: { ...zeroTotals(), calories: 335, protein: 28 },
      macros: ["added_sugar"],
    })
    expect(keyboard.inline_keyboard[0][0].text).toBe("✅ Log 335 cal")
  })
```

**`src/bot/commands/delete.test.ts`.**
- Add `createDeleteMessageHandler` to the `./delete` import and `import type { FoodItem } from "../../db/repositories/food-logs"`.
- Change the `logItems` helper's `items` parameter type to `FoodItem[]`.
- Add `["protein"]` as the fourth argument of every existing `resolveDeleteCallback(...)` call. Expected values stay the same.
- Change every `createDeleteCallbackHandler(foodLogsRepo)` to `createDeleteCallbackHandler(foodLogsRepo, usersRepo)`.
- Add inside `describe("resolveDeleteCallback")`:

```ts
  test("the summary follows the macros it is given", () => {
    const items = logItems(OWNER, [{ description: "Adobo", calories: 420, protein_g: 38, fiber_g: 1, emoji: "🍗" }])
    const decision = resolveDeleteCallback(
      { action: "all", ownerId: OWNER, date: DATE, token: deleteAllToken(items) },
      OWNER,
      foodLogsRepo,
      ["fiber"]
    )
    expect(decision).toEqual({ kind: "done", edit: "🗑 Deleted 1 entries (420 cal · 1 g fiber) for Fri, Sep 25.", toast: "Deleted" })
  })
```

- Add inside `describe("createDeleteCallbackHandler")`:

```ts
  test("the edited message uses the owner's macros", async () => {
    usersRepo.updateSettings(OWNER, { tracked_macros: ["protein", "fat"] })
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, fat_g: 18, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }))

    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal · 22 g · 18 g fat", undefined)
  })
```

- Append:

```ts
describe("typed /delete follows the user's macros", () => {
  test("the list and the single-item prompt show the tracked macros", async () => {
    usersRepo.updateSettings(OWNER, { tracked_macros: ["added_sugar"] })
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    foodLogsRepo.create(OWNER, 555, today, [{ description: "Halo-halo", calories: 350, added_sugar_g: 40, emoji: "🍧" }])

    const command = { from: { id: OWNER, first_name: "Maria" }, chat: { type: "private" }, message: { text: "/delete" }, reply: mock(() => Promise.resolve()) }
    await createDeleteCommand(foodLogsRepo, usersRepo)(command as unknown as Context)
    expect(command.reply).toHaveBeenCalledWith(expect.stringContaining("1. 🍧 Halo-halo — 350 cal · 40 g sugar"), undefined)

    const typed = { from: { id: OWNER, first_name: "Maria" }, chat: { type: "private" }, message: { text: "1" }, reply: mock(() => Promise.resolve()) }
    await createDeleteMessageHandler(foodLogsRepo, usersRepo)(typed as unknown as Context)
    expect(typed.reply).toHaveBeenCalledWith("Delete this entry?\n\n🍧 Halo-halo — 350 cal · 40 g sugar", expect.anything())
  })
})
```

**`src/jobs/retry-pending.test.ts`.** Append:

```ts
test("the processed-entry message follows the user's macros", async () => {
  const pendingRepo = new PendingRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(42, "ray")
  usersRepo.updateSettings(42, { tracked_macros: ["fiber"] })
  pendingRepo.create(42, -100, "chicken adobo", "2026-09-21")

  const estimate = mock(() =>
    Promise.resolve({
      items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, fiber_g: 1, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high" as const,
    })
  )
  const bot = { api: { sendMessage: mock(() => Promise.resolve()) } }

  await createRetryPendingJob(bot as any, pendingRepo, foodLogsRepo, usersRepo, { estimate } as unknown as AIService)()

  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    42,
    "✅ Processed your saved entry — logged to Mon, Sep 21:\n\n" +
      "<blockquote>🍗 Chicken adobo — 420 cal · 1 g fiber</blockquote>\n\n<b>Total: 420 cal · 1 g fiber</b>",
    { parse_mode: "HTML" }
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/bot src/jobs/retry-pending.test.ts`
Expected: FAIL in the new tests (replies still show protein only; `confirm` has no `macros`).

- [ ] **Step 3: `LogFlow`**

In `src/bot/conversations/log-flow.ts`:
- Add `import { UsersRepository } from "../../db/repositories/users"` and change the macros import to `import { DEFAULT_MACROS, type MacroKey, type Totals } from "../../macros"`.
- Change `confirm?: { token: string; totals: Totals }` to `confirm?: { token: string; totals: Totals; macros: MacroKey[] }`.
- Replace the constructor with:

```ts
  constructor(
    private conversations: ConversationsRepository,
    private foodLogs: FoodLogsRepository,
    private pending: PendingRepository,
    private aiService: AIService,
    private users: Pick<UsersRepository, "findById">
  ) {}

  /** The macros this user's replies show. */
  private macrosFor(telegramId: number): MacroKey[] {
    return this.users.findById(telegramId)?.tracked_macros ?? [...DEFAULT_MACROS]
  }
```

- In `handleConfirming`, change the logged message to:

```ts
        message: `Logged ${formatTotals(sumTotals(items), this.macrosFor(telegramId))} for ${formatDateForDisplay(state.target_date)}.`,
```

- In `resolveConfirmation`, add `const macros = this.macrosFor(telegramId)` after `if (items.length === 0) return { stale: true }`, and replace `DEFAULT_MACROS` with `macros` in its three `formatItemsSummary` calls.
- Replace `confirmationResult` with:

```ts
  private confirmationResult(
    telegramId: number,
    header: string,
    items: FoodItem[],
    targetDate: string,
    pendingItems: string,
    action: "prompt" | "continue"
  ): LogFlowResult {
    const macros = this.macrosFor(telegramId)
    return {
      message: `${header}\n\n${formatItemsSummary(items, macros)}`,
      action,
      parseMode: "HTML",
      confirm: {
        token: confirmToken(targetDate, pendingItems),
        totals: sumTotals(items),
        macros,
      },
    }
  }
```

- In `processEstimationResult`, pass `telegramId` as the new first argument of `this.confirmationResult(`.
- In `getStatusMessage`, add `telegram_id: number` to its parameter type, and pass `state.telegram_id` as the first argument of its `this.confirmationResult(` call.

- [ ] **Step 4: The confirm button**

In `src/bot/commands/log.ts`, change the macros import to `import type { MacroKey, Totals } from "../../macros"` and replace `buildLogConfirmKeyboard` with:

```ts
export function buildLogConfirmKeyboard(
  ownerId: number,
  confirm: { token: string; totals: Totals; macros: readonly MacroKey[] }
): InlineKeyboard {
  const data = (action: LogAction) => encodeLogCallback({ action, ownerId, token: confirm.token })
  // Calories and protein only: a longer label does not fit on a button.
  const protein = confirm.macros.includes("protein") ? ` · ${confirm.totals.protein} g` : ""
  return new InlineKeyboard()
    .text(`✅ Log ${confirm.totals.calories} cal${protein}`, data("ok"))
    .row()
    .text("✏️ Change", data("chg"))
    .text("✖️ Cancel", data("cxl"))
}
```

- [ ] **Step 5: `/delete`**

In `src/bot/commands/delete.ts`, change the macros import to `import { DEFAULT_MACROS, type MacroKey } from "../../macros"`, then:

- Replace `formatItemsList`, `promptConfirmOne` and `promptConfirmAll` with:

```ts
function formatItemsList(items: DeletableItem[], macros: readonly MacroKey[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item, macros)}`).join("\n")
}
```

```ts
async function promptConfirmOne(ctx: Context, ownerId: number, item: DeletableItem, macros: readonly MacroKey[]): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("🗑 Delete", encodeDeleteCallback({ action: "one", ownerId, itemId: Number(item.id) }))
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(ctx, `Delete this entry?\n\n${formatItemLine(item, macros)}`, { reply_markup: keyboard })
}

async function promptConfirmAll(
  ctx: Context,
  ownerId: number,
  targetDate: string,
  items: DeletableItem[],
  macros: readonly MacroKey[]
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(
      "🗑 Delete all",
      encodeDeleteCallback({ action: "all", ownerId, date: targetDate, token: deleteAllToken(items) })
    )
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(
    ctx,
    `Delete all ${items.length} entries for ${formatDateForDisplay(targetDate)}? (${formatTotals(sumTotals(items), macros)} total)`,
    { reply_markup: keyboard }
  )
}
```

- In `createDeleteCommand`, add `const macros = user?.tracked_macros ?? DEFAULT_MACROS` after `const user = …`, and pass `macros` to `promptConfirmOne`, `promptConfirmAll` and `formatItemsList`.
- Change `export function createDeleteMessageHandler(foodLogsRepo: FoodLogsRepository)` to `export function createDeleteMessageHandler(foodLogsRepo: FoodLogsRepository, usersRepo: UsersRepository)`. After `if (!state) return`, add `const macros = usersRepo.findById(userId)?.tracked_macros ?? DEFAULT_MACROS`. Pass `macros` to both prompt calls, and replace `DEFAULT_MACROS` with `macros` in the `Deleted:` and `Deleted ${count} entries` replies.
- Change `resolveDeleteCallback`'s signature to

```ts
export function resolveDeleteCallback(
  cb: DeleteCallback,
  presserId: number,
  foodLogsRepo: FoodLogsRepository,
  macros: readonly MacroKey[]
): DeleteDecision {
```

  and replace `DEFAULT_MACROS` with `macros` in its two edits.
- Change `export function createDeleteCallbackHandler(foodLogsRepo: FoodLogsRepository)` to take `usersRepo: UsersRepository` as a second parameter, and change the decision line to:

```ts
    const macros = usersRepo.findById(presserId)?.tracked_macros ?? DEFAULT_MACROS
    const decision = resolveDeleteCallback(parsed, presserId, foodLogsRepo, macros)
```

- [ ] **Step 6: Retry job, wiring and the mock renderer**

`src/jobs/retry-pending.ts`: change `formatItemsSummary(result.items, DEFAULT_MACROS)` to `formatItemsSummary(result.items, user?.tracked_macros ?? DEFAULT_MACROS)`.

`src/bot/index.ts`:
- `new LogFlow(conversationsRepo, foodLogsRepo, pendingRepo, aiService)` → `new LogFlow(conversationsRepo, foodLogsRepo, pendingRepo, aiService, usersRepo)`
- `createDeleteCallbackHandler(foodLogsRepo)` → `createDeleteCallbackHandler(foodLogsRepo, usersRepo)`
- `createDeleteMessageHandler(foodLogsRepo)` → `createDeleteMessageHandler(foodLogsRepo, usersRepo)`

`scripts/telegram-mock/render.ts`: in `keyboardLabels`, change `buildLogConfirmKeyboard(1, { token: "mock", totals })` to `buildLogConfirmKeyboard(1, { token: "mock", totals, macros: DEFAULT_MACROS })`.

- [ ] **Step 7: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

Run the scripts typecheck (Global Constraints).
Expected: exit 0, no output.

- [ ] **Step 8: Commit**

```bash
git add src scripts
git commit -m "feat(bot): log card, /delete and retried entries show the user's macros" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `/today`, `/week`, `/month` and reminders follow the user's macros

**Files:**
- Modify: `src/bot/commands/today.ts`, `src/bot/commands/stats.ts`, `src/jobs/reminders.ts`, `scripts/telegram-mock/render.ts`
- Test: `src/bot/commands/today.test.ts`, `src/bot/commands/stats.test.ts`, `src/jobs/reminders.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MacroKey`, `DEFAULT_MACROS` (Task 1); `User.tracked_macros` (Task 7); `formatGoalProgress` with an optional emoji (Task 3).
- Produces:
  - `buildTodayMessage({ date, items, totals, dailyGoal, proteinGoal, macros: readonly MacroKey[] })`
  - `buildStatsMessage({ period, days, dateRange, dailyTotals, dailyGoal, proteinGoal, macros: readonly MacroKey[] })`
  - `formatReminderMessage(username, mention, totals, dailyGoal, proteinGoal, hasLogs, macros: readonly MacroKey[])`

- [ ] **Step 1: Write the failing tests**

**`src/bot/commands/today.test.ts`.** Add `macros: ["protein"]` to the three existing `buildTodayMessage` calls (expected text unchanged). Append inside the describe:

```ts
  test("extra macros get one line each, no emoji, under the protein block", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items: [{ id: 1, description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }],
      totals: { calories: 1050, protein: 50, fat: 36, fiber: 1, added_sugar: 2 },
      dailyGoal: 2000,
      proteinGoal: 120,
      macros: ["protein", "fat", "fiber", "added_sugar"],
    })
    expect(out).toBe(
      "📅 Fri, Sep 25\n\n" +
        "1. 🍗 Chicken adobo — 420 cal · 38 g · 24 g fat · 1 g fiber · 2 g sugar\n\n" +
        "📊 Calories: 1,050 / 2,000 cal\n█████░░░░░ 53%\n✨ 950 cal remaining\n\n" +
        "💪 Protein: 50 / 120 g\n████░░░░░░ 42%\n✨ 70 g remaining\n\n" +
        "Fat: 36 g\nFiber: 1 g\nAdded sugar: 2 g"
    )
  })

  test("with protein off, the extra lines follow the calorie block", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { calories: 330, protein: 14, fat: 9, fiber: 0, added_sugar: 0 },
      dailyGoal: undefined,
      proteinGoal: 120,
      macros: ["fat"],
    })
    expect(out.endsWith("📊 Calories: 330 cal\n\nFat: 9 g")).toBe(true)
    expect(out).not.toContain("Protein")
  })

  test("with no macros, only the calorie block", () => {
    const out = buildTodayMessage({ date: "2026-09-25", items, totals: { ...zeroTotals(), calories: 330 }, dailyGoal: undefined, proteinGoal: 120, macros: [] })
    expect(out.endsWith("2. 🍞 Toast — 150 cal\n\n📊 Calories: 330 cal")).toBe(true)
  })
```

**`src/bot/commands/stats.test.ts`.** Add `macros: ["protein"]` to every existing `buildStatsMessage` call. Append to the week describe:

```ts
  test("rows keep calories and protein; total and average carry every tracked macro", () => {
    const totals = {
      "2026-09-21": { calories: 1450, protein: 82, fat: 48, fiber: 18, added_sugar: 22 },
      "2026-09-22": { calories: 2100, protein: 130, fat: 70, fiber: 25, added_sugar: 40 },
    }
    const out = buildStatsMessage({
      period: "Week",
      days: 7,
      dateRange: WEEK,
      dailyTotals: totals,
      dailyGoal: null,
      proteinGoal: null,
      macros: ["protein", "fat", "fiber", "added_sugar"],
    })

    expect(out).toContain("Mon: ███░░ 1,450 cal · 82 g\n")
    expect(out).toContain("📈 Total: 3,550 cal · 212 g protein · 118 g fat · 43 g fiber · 62 g added sugar\n")
    expect(out).toContain("📊 Daily avg: 1,775 cal · 106 g protein · 59 g fat · 22 g fiber · 31 g added sugar\n")
  })

  test("with protein off: no protein in rows, totals or goal lines", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals, dailyGoal: 2000, proteinGoal: 120, macros: [] })

    expect(out).toContain("Mon: ████░ 1,450 cal\n")
    expect(out).toContain("📈 Total: 5,350 cal\n")
    expect(out).toContain("📅 Days tracked: 3/7\n\n🎯 Under calorie goal: 2/3 days (67%)")
    expect(out).not.toContain("protein")
    expect(out).not.toContain("Protein")
  })
```

and to the month describe:

```ts
  test("weekly rows drop protein when it is off", () => {
    const dateRange: string[] = []
    for (let d = 1; d <= 30; d++) dateRange.push(`2026-09-${String(d).padStart(2, "0")}`)
    const out = buildStatsMessage({
      period: "Month",
      days: 30,
      dateRange,
      dailyTotals: { "2026-09-01": { ...zeroTotals(), calories: 9800, protein: 520 } },
      dailyGoal: null,
      proteinGoal: null,
      macros: [],
    })
    expect(out).toContain("Week 1: 9,800 cal (avg 1,400 cal/day)\n")
  })
```

**`src/jobs/reminders.test.ts`.** Add `["protein"]` as the seventh argument of the four existing `formatReminderMessage` calls. Append inside `describe("formatReminderMessage")`:

```ts
  test("adds a line per extra macro after protein", () => {
    expect(
      formatReminderMessage("maria", true, { calories: 1450, protein: 82, fat: 38, fiber: 18, added_sugar: 22 }, 2000, 120, true, [
        "protein",
        "fat",
        "added_sugar",
      ])
    ).toBe(
      "@maria Daily check-in 🍽️\n\n" +
        "Current: 1,450 / 2,000 cal (73%)\n" +
        "Protein: 82 / 120 g (68%)\n" +
        "Fat: 38 g\n" +
        "Added sugar: 22 g\n\n" +
        "550 cal remaining — keep it up!"
    )
  })

  test("with protein off and no calorie goal, calories and the extra macros", () => {
    expect(
      formatReminderMessage(null, false, { calories: 900, protein: 40, fat: 30, fiber: 9, added_sugar: 5 }, null, 120, true, ["fiber"])
    ).toBe("Daily check-in 🍽️\n\nToday's total: 900 cal\nFiber: 9 g")
  })

  test("with no macros, calories only", () => {
    expect(formatReminderMessage(null, false, { ...zeroTotals(), calories: 900, protein: 40 }, 2000, null, true, [])).toBe(
      "Daily check-in 🍽️\n\nCurrent: 900 / 2,000 cal (45%)\n\n1,100 cal remaining — keep it up!"
    )
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/bot/commands/today.test.ts src/bot/commands/stats.test.ts src/jobs/reminders.test.ts`
Expected: FAIL in the new tests.

- [ ] **Step 3: `/today`**

In `src/bot/commands/today.ts`, change the macros import to `import { MACROS, DEFAULT_MACROS, type MacroKey } from "../../macros"` and replace `buildTodayMessage` (with its comment) by:

```ts
/**
 * The /today body: numbered item lines, the calorie block, the protein block
 * when protein is tracked, then one line per other tracked macro. Pure, so the
 * layout is testable without a bot.
 */
export function buildTodayMessage(opts: {
  date: string
  items: FoodItem[]
  totals: DayTotals
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
  macros: readonly MacroKey[]
}): string {
  const { macros } = opts
  let message = `📅 ${formatDateForDisplay(opts.date)}\n\n`
  opts.items.forEach((item, i) => {
    message += `${i + 1}. ${formatItemLine(item, macros)}\n`
  })
  message += "\n"
  message += formatGoalProgress({ emoji: "📊", label: "Calories", current: opts.totals.calories, goal: opts.dailyGoal, unit: "cal" })
  if (macros.includes("protein")) {
    message += "\n\n"
    message += formatGoalProgress({ emoji: "💪", label: "Protein", current: opts.totals.protein, goal: opts.proteinGoal, unit: "g" })
  }
  const others = MACROS.filter((m) => m.key !== "protein" && macros.includes(m.key))
  if (others.length > 0) {
    message += "\n\n"
    message += others.map((m) => formatGoalProgress({ label: m.name, current: opts.totals[m.key], goal: null, unit: "g" })).join("\n")
  }
  return message
}
```

In `createTodayCommand`, add `macros: user?.tracked_macros ?? DEFAULT_MACROS,` to the `buildTodayMessage({ … })` call.

- [ ] **Step 4: `/week` and `/month`**

In `src/bot/commands/stats.ts`, add `type MacroKey` to the macros import, then replace the signature and body of `buildStatsMessage` from the destructuring line down to the end of the protein goal line with:

```ts
export function buildStatsMessage(opts: {
  period: string
  days: number
  dateRange: string[]
  dailyTotals: Record<string, DayTotals>
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
  macros: readonly MacroKey[]
}): string {
  const { period, days, dateRange, dailyTotals, dailyGoal, proteinGoal, macros } = opts
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

  const total = loggedDays.reduce(addTotals, zeroTotals())
  const avg = averageTotals(total, daysWithData)

  // Rows show calories and protein only: four macros would wrap each row onto
  // two or three lines. The total and the daily average carry every macro.
  const showProtein = macros.includes("protein")
  const grams = (value: number) => (showProtein ? ` · ${n(value)} g` : "")

  if (days <= 7) {
    for (const date of dateRange) {
      const day = dailyTotals[date]
      const dayName = getDayOfWeek(date).slice(0, 3)
      if (day && day.calories > 0) {
        const bar = createMiniBar(day.calories, dailyGoal || avg.calories * 1.2)
        message += `${dayName}: ${bar} ${n(day.calories)} cal${grams(day.protein)}\n`
      } else {
        message += `${dayName}: ░░░░░ —\n`
      }
    }
  } else {
    const weeks = splitIntoWeeks(dateRange, dailyTotals)
    weeks.forEach((week, i) => {
      message +=
        `Week ${i + 1}: ${formatTotals(week, showProtein ? ["protein"] : [])} ` +
        `(avg ${n(Math.round(week.calories / 7))} cal${grams(Math.round(week.protein / 7))}/day)\n`
    })
  }

  message += "\n"
  message += `📈 Total: ${formatTotals(total, macros)}\n`
  message += `📊 Daily avg: ${formatTotals(avg, macros)}\n`
  message += `📅 Days tracked: ${daysWithData}/${days}`
  if (dailyGoal || (showProtein && proteinGoal)) message += "\n"

  if (dailyGoal) {
    const under = loggedDays.filter((d) => d.calories <= dailyGoal).length
    message += `\n🎯 Under calorie goal: ${under}/${daysWithData} days (${Math.round((under / daysWithData) * 100)}%)`
  }
  if (showProtein && proteinGoal) {
    const met = loggedDays.filter((d) => d.protein >= proteinGoal).length
    message += `\n💪 Protein goal met: ${met}/${daysWithData} days (${Math.round((met / daysWithData) * 100)}%)`
  }

  return message
}
```

In `sendStatsMessage`, add `macros: user?.tracked_macros ?? DEFAULT_MACROS,` to the `buildStatsMessage({ … })` call.

- [ ] **Step 5: Reminders**

In `src/jobs/reminders.ts`, add `import { MACROS, type MacroKey } from "../macros"` and replace `formatReminderMessage` with:

```ts
export function formatReminderMessage(
  username: string | null,
  mention: boolean,
  totals: DayTotals,
  dailyGoal: number | null,
  proteinGoal: number | null,
  hasLogs: boolean,
  macros: readonly MacroKey[]
): string {
  const namePrefix = mention && username ? `@${username} ` : ""

  if (!hasLogs) {
    const goalText = dailyGoal ? `Goal: ${n(dailyGoal)} cal` : ""
    return (
      `${namePrefix}Haven't seen any logs today! 🍽️\n` +
      `Current: 0 cal${goalText ? ` | ${goalText}` : ""}\n\n` +
      `Use /log to track what you've eaten.`
    )
  }

  const macroLines: string[] = []
  if (macros.includes("protein")) {
    macroLines.push(
      proteinGoal
        ? `Protein: ${n(totals.protein)} / ${n(proteinGoal)} g (${Math.round((totals.protein / proteinGoal) * 100)}%)`
        : `Protein: ${n(totals.protein)} g`
    )
  }
  for (const m of MACROS) {
    if (m.key !== "protein" && macros.includes(m.key)) macroLines.push(`${m.name}: ${n(totals[m.key])} g`)
  }

  if (dailyGoal) {
    const percent = Math.round((totals.calories / dailyGoal) * 100)
    const remaining = dailyGoal - totals.calories
    const closing = remaining > 0 ? `${n(remaining)} cal remaining — keep it up!` : `You've reached your goal for today!`
    const lines = [`Current: ${n(totals.calories)} / ${n(dailyGoal)} cal (${percent}%)`, ...macroLines]
    return `${namePrefix}Daily check-in 🍽️\n\n${lines.join("\n")}\n\n${closing}`
  }

  const lines = [`Today's total: ${n(totals.calories)} cal`, ...macroLines]
  return `${namePrefix}Daily check-in 🍽️\n\n${lines.join("\n")}`
}
```

In `createReminderJob`, add `user.tracked_macros` as the last argument of `formatReminderMessage(...)`.

- [ ] **Step 6: The mock renderer**

In `scripts/telegram-mock/render.ts`, add `macros: DEFAULT_MACROS` to the `buildTodayMessage({ … })` call.

- [ ] **Step 7: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

Run the scripts typecheck (Global Constraints).
Expected: exit 0, no output.

- [ ] **Step 8: Commit**

```bash
git add src scripts
git commit -m "feat(bot): /today, /week, /month and reminders show the user's macros" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `/edit` sets any macro by name

**Files:**
- Modify: `src/bot/commands/edit.ts`
- Test: `src/bot/commands/edit.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MAX_GRAMS`, `DEFAULT_MACROS`, `getMacro`, `macroByKeyword`, `macroValuesOf`, `withMacro`, `MacroKey`, `MacroValues` (Task 1); `User.tracked_macros` (Task 7).
- Produces: `parseEditInput(text)` returns `{ kind: "macro"; key: MacroKey; value: number }` in place of `{ kind: "protein"; value }`. The other kinds are unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/bot/commands/edit.test.ts`:

1. Replace `"a number with g sets protein, case-insensitive, with or without a space"` with:

```ts
  test("a number with g sets protein, case-insensitive, with or without a space", () => {
    expect(parseEditInput("18g")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("18 G")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("0g")).toEqual({ kind: "macro", key: "protein", value: 0 })
  })

  test("a macro's name after the grams sets that macro", () => {
    expect(parseEditInput("18g protein")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("24g fat")).toEqual({ kind: "macro", key: "fat", value: 24 })
    expect(parseEditInput("5 g Fibre")).toEqual({ kind: "macro", key: "fiber", value: 5 })
    expect(parseEditInput("3g sugar")).toEqual({ kind: "macro", key: "added_sugar", value: 3 })
    expect(parseEditInput("3g added  sugar")).toEqual({ kind: "macro", key: "added_sugar", value: 3 })
  })

  test("grams of anything else is a description", () => {
    expect(parseEditInput("200g chicken")).toEqual({ kind: "describe", text: "200g chicken" })
  })
```

2. In `"out-of-range numbers are rejected with a message"`, add:

```ts
    expect(parseEditInput("1500g sugar")).toEqual({ kind: "invalid", message: "Added sugar must be between 0 and 1000 g." })
```

3. Append inside `describe("edit flow")`:

```ts
  test("the prompt adds the macro hint when an extra macro is tracked", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["protein", "added_sugar"] })
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    foodLogsRepo.create(USER, 555, today, [{ description: "Chicken adobo (2 pcs)", calories: 420, protein_g: 38, added_sugar_g: 2, emoji: "🍗" }])
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 2 g sugar\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200 or 200 cal)\n" +
        "• Type a number with g to set protein (e.g. 18g)\n" +
        "• Add the macro's name to set another (e.g. 5g sugar)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("with protein off, the protein hint goes and the example uses the first extra macro", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["fat", "fiber"] })
    logToday()
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍜 Ramen — 520 cal · ? g fat · ? g fiber\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200 or 200 cal)\n" +
        "• Add the macro's name to set another (e.g. 5g fat)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("3g sugar updates only added sugar", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["protein", "added_sugar"] })
    const item = logToday()
    const ctx = await editWith("3g sugar")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 520, protein_g: 22, added_sugar_g: 3 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 22 g · 3 g sugar", undefined)
  })

  test("a macro the user doesn't track is still saved, and the reply shows it", async () => {
    const item = logToday()
    const ctx = await editWith("24g fat")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ fat_g: 24 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 22 g · 24 g fat", undefined)
  })

  test("re-estimating replaces every macro", async () => {
    const item = logToday()
    const estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Tonkotsu ramen", calories: 650, protein_g: 30, fat_g: 28, fiber_g: 3, added_sugar_g: 1, emoji: "🍜" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await editWith("tonkotsu ramen", { estimate } as unknown as AIService)

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ protein_g: 30, fat_g: 28, fiber_g: 3, added_sugar_g: 1 })
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/bot/commands/edit.test.ts`
Expected: FAIL in the new and changed tests.

- [ ] **Step 3: Implement**

In `src/bot/commands/edit.ts`:

- Change the macros import to:

```ts
import {
  MACROS,
  MAX_GRAMS,
  DEFAULT_MACROS,
  getMacro,
  macroByKeyword,
  macroValuesOf,
  withMacro,
  type MacroKey,
  type MacroValues,
} from "../../macros"
```

- Replace `formatItemsList`, `editPrompt`, `EditInput` and `parseEditInput` with:

```ts
function formatItemsList(items: (FoodItem & { log_id: number })[], macros: readonly MacroKey[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item, macros)}`).join("\n")
}

function editPrompt(item: FoodItem, macros: readonly MacroKey[]): string {
  const hints = ["• Type a number to set calories (e.g. 200 or 200 cal)"]
  if (macros.includes("protein")) hints.push("• Type a number with g to set protein (e.g. 18g)")
  const extra = MACROS.find((m) => m.key !== "protein" && macros.includes(m.key))
  if (extra) hints.push(`• Add the macro's name to set another (e.g. 5g ${extra.keywords[0]})`)
  hints.push("• Or describe the food to re-estimate", '• Type "cancel" to abort')
  return `Editing: ${formatItemLine(item, macros)}\n\nWhat would you like to change?\n${hints.join("\n")}`
}

export type EditInput =
  | { kind: "calories"; value: number }
  | { kind: "macro"; key: MacroKey; value: number }
  | { kind: "invalid"; message: string }
  | { kind: "describe"; text: string }

/** Every macro's /edit words, longest first, a space matching any run of whitespace. */
const MACRO_WORDS = MACROS.flatMap((m) => [...m.keywords])
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/ /g, "\\s+"))
  .join("|")
/** "18g" or "18 g" (protein), or "3g sugar": grams, then optionally a macro's word. */
const MACRO_INPUT = new RegExp(`^\\s*(\\d+)\\s*g(?:\\s+(${MACRO_WORDS}))?\\s*$`, "i")

/** "200" → calories, "18g" → protein, "3g sugar" → that macro, anything else → re-estimate. */
export function parseEditInput(text: string): EditInput {
  const grams = text.match(MACRO_INPUT)
  if (grams) {
    const macro = grams[2] ? macroByKeyword(grams[2])! : getMacro("protein")
    const value = parseInt(grams[1], 10)
    if (value > MAX_GRAMS) return { kind: "invalid", message: `${macro.name} must be between 0 and ${MAX_GRAMS} g.` }
    return { kind: "macro", key: macro.key, value }
  }

  const calories = text.match(/^\s*(\d+)\s*(?:k?cal(?:ories)?)?\s*$/i)
  if (calories) {
    const value = parseInt(calories[1], 10)
    if (value < 1 || value > 9999) return { kind: "invalid", message: "Calories must be between 1 and 9999." }
    return { kind: "calories", value }
  }

  return { kind: "describe", text: text.trim() }
}
```

- In `createEditCommand`, add `const macros = user?.tracked_macros ?? DEFAULT_MACROS` after `const user = …`; change `editPrompt(item)` to `editPrompt(item, macros)` and `formatItemsList(items)` to `formatItemsList(items, macros)`.
- In `createEditMessageHandler`, add after `if (!state) return`:

```ts
    const macros = usersRepo.findById(userId)?.tracked_macros ?? DEFAULT_MACROS
```

  - In the `"select"` case, change `editPrompt(item)` to `editPrompt(item, macros)`.
  - In the `"edit"` case, replace the `calories` and `protein` branches with:

```ts
        if (input.kind === "calories") {
          foodLogsRepo.updateItem(item.id!, { calories: input.value })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, calories: input.value }, macros)}`)
          return
        }

        if (input.kind === "macro") {
          const update: Partial<MacroValues> = { [getMacro(input.key).column]: input.value }
          foodLogsRepo.updateItem(item.id!, update)
          editStates.delete(userId)
          // The edited macro shows even if the user doesn't track it, so they see it took.
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, ...update }, withMacro(macros, input.key))}`)
          return
        }
```

  - In the re-estimate branch, change `formatItemLine(newItem, DEFAULT_MACROS)` to `formatItemLine(newItem, macros)`.

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(edit): set any macro by name, e.g. 3g sugar" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `/settings` → Macros, and the `/start` sentence

**Files:**
- Modify: `src/bot/commands/settings.ts`, `src/bot/help.ts`
- Test: `src/bot/commands/settings.test.ts`, `src/bot/help.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `isMacroKey`, `getMacro`, `withMacro`, `MacroKey` (Task 1); `User.tracked_macros` and `updateSettings({ tracked_macros })` (Task 7).
- Produces: `MACROS_SCREEN_TEXT: string`, `createMacrosKeyboard(tracked: readonly MacroKey[]): InlineKeyboard`, callbacks `settings:macros` and `settings:macro:<key>`; `formatSettings` takes `tracked_macros`.

- [ ] **Step 1: Write the failing tests**

In `src/bot/commands/settings.test.ts`:
- Add `MACROS_SCREEN_TEXT` and `createMacrosKeyboard` to the `./settings` import.
- Replace `describe("createMainKeyboard", …)` with:

```ts
describe("createMainKeyboard", () => {
  test("has a Macros button beside the protein goal", () => {
    const rows = createMainKeyboard().inline_keyboard.map((row) => row.map((b) => b.text))
    expect(rows).toEqual([
      ["Change Provider", "Set Calorie Goal"],
      ["Set Protein Goal", "Macros"],
      ["Set Reminder", "Set Timezone"],
      ["Meal Text Sharing", "Close"],
    ])
  })
})
```

- Add inside `describe("formatSettings")`:

```ts
  test("lists the tracked macros after the protein goal", () => {
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Protein Goal: Not set\nMacros: Protein\n")

    usersRepo.updateSettings(USER, { tracked_macros: ["added_sugar", "protein"] })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Macros: Protein, Added sugar\n")

    usersRepo.updateSettings(USER, { tracked_macros: [] })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Macros: None\n")
  })
```

- Append:

```ts
describe("Macros screen", () => {
  test("the text says what the toggles do", () => {
    expect(MACROS_SCREEN_TEXT).toBe(
      "⚙️ Macros\n\nCalories always show. Pick what else shows beside them. Every meal is estimated for all four, so switching one on shows it for earlier meals too."
    )
  })

  test("Macros opens the screen with a button per macro", async () => {
    const ctx = callbackCtx("settings:macros")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(["protein"]) })
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    const rows = createMacrosKeyboard(["protein"]).inline_keyboard.map((row) => row.map((b) => b.text))
    expect(rows).toEqual([["Protein ✓", "Fat"], ["Fiber", "Added sugar"], ["← Back"]])
  })

  test("a macro button switches it on, then off, and redraws", async () => {
    const on = callbackCtx("settings:macro:fiber")
    await createSettingsCallbackHandler(usersRepo, aiService)(on as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein", "fiber"])
    expect(on.editMessageText).toHaveBeenCalledWith(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(["protein", "fiber"]) })
    expect(on.answerCallbackQuery).toHaveBeenCalledWith("Fiber on")

    const off = callbackCtx("settings:macro:fiber")
    await createSettingsCallbackHandler(usersRepo, aiService)(off as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein"])
    expect(off.answerCallbackQuery).toHaveBeenCalledWith("Fiber off")
  })

  test("protein can be switched off too", async () => {
    await createSettingsCallbackHandler(usersRepo, aiService)(callbackCtx("settings:macro:protein") as unknown as Context)
    expect(usersRepo.findById(USER)!.tracked_macros).toEqual([])
  })

  test("an unknown macro changes nothing", async () => {
    const ctx = callbackCtx("settings:macro:carbs")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein"])
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
  })

  test("Back returns to the main settings view", async () => {
    const ctx = callbackCtx("settings:back")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(formatSettings(usersRepo.findById(USER)!), { reply_markup: createMainKeyboard() })
  })
})
```

In `src/bot/help.test.ts`, add inside the describe:

```ts
  test("says where to switch on the other macros", () => {
    expect(HELP_TEXT).toContain(
      "Track your calories and protein with AI-powered estimation. Switch on fat, fiber and added sugar in /settings → Macros.\n\n"
    )
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/bot/commands/settings.test.ts src/bot/help.test.ts`
Expected: FAIL in the new and changed tests.

- [ ] **Step 3: Implement**

In `src/bot/commands/settings.ts`:
- Add `import { MACROS, isMacroKey, getMacro, withMacro, type MacroKey } from "../../macros"`.
- Replace `createMainKeyboard` with:

```ts
export function createMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Change Provider", "settings:provider")
    .text("Set Calorie Goal", "settings:goal")
    .row()
    .text("Set Protein Goal", "settings:protein")
    .text("Macros", "settings:macros")
    .row()
    .text("Set Reminder", "settings:reminder")
    .text("Set Timezone", "settings:timezone")
    .row()
    .text("Meal Text Sharing", "settings:analytics")
    .text("Close", "settings:close")
}

export const MACROS_SCREEN_TEXT =
  "⚙️ Macros\n\n" +
  "Calories always show. Pick what else shows beside them. Every meal is estimated for all four, so switching one on shows it for earlier meals too."

/** Two macros a row, ✓ on the tracked ones (like the provider picker), then Back. */
export function createMacrosKeyboard(tracked: readonly MacroKey[]): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (let i = 0; i < MACROS.length; i += 2) {
    for (const m of MACROS.slice(i, i + 2)) {
      keyboard.text(tracked.includes(m.key) ? `${m.name} ✓` : m.name, `settings:macro:${m.key}`)
    }
    keyboard.row()
  }
  return keyboard.text("← Back", "settings:back")
}
```

- In `formatSettings`, add `tracked_macros: readonly MacroKey[]` to the parameter type, add

```ts
  const macros = user.tracked_macros.length > 0 ? user.tracked_macros.map((key) => getMacro(key).name).join(", ") : "None"
```

  under the `proteinGoal` line, and add `` `Macros: ${macros}\n` + `` after the `` `Protein Goal: ${proteinGoal}\n` + `` line.
- In the callback handler's `switch (action)`, add before `case "reminder":`:

```ts
      case "macros": {
        await ctx.editMessageText(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(user.tracked_macros) })
        await ctx.answerCallbackQuery()
        break
      }
```

- In the `default:` branch, add before `if (action.startsWith("provider:"))`:

```ts
        // Handle a macro toggle: settings:macro:fiber
        if (action.startsWith("macro:")) {
          const key = action.slice("macro:".length)
          if (!isMacroKey(key)) {
            await ctx.answerCallbackQuery()
            break
          }
          const on = !user.tracked_macros.includes(key)
          const next = on ? withMacro(user.tracked_macros, key) : user.tracked_macros.filter((k) => k !== key)
          usersRepo.updateSettings(userId, { tracked_macros: next })
          await ctx.editMessageText(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(next) })
          await ctx.answerCallbackQuery(`${getMacro(key).name} ${on ? "on" : "off"}`)
          break
        }
```

In `src/bot/help.ts`, change the line `"Track your calories and protein with AI-powered estimation.\n\n" +` to:

```ts
  "Track your calories and protein with AI-powered estimation. Switch on fat, fiber and added sugar in /settings → Macros.\n\n" +
```

- [ ] **Step 4: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(settings): /settings → Macros switches each macro on or off" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Web and docs

### Task 12: The Mini App and its API show the user's macros

**Files:**
- Modify: `src/web/api.ts`, `src/web/views/app.html`
- Create: `src/web/app-page.test.ts`
- Test: `src/web/api.test.ts`

**Interfaces:**
- Consumes: `MACROS`, `MacroKey`, `DEFAULT_MACROS`, `macroValuesOf` (Task 1); `User.tracked_macros` (Task 7); `sumTotals` (Task 3).
- Produces (all additive):
  - `/api/user`: `tracked_macros: MacroKey[]`
  - `/api/today` and `/api/day/:date`: `fat_g`, `fiber_g`, `added_sugar_g` on each item; `macros: Record<MacroKey, number>` beside `total` and `protein`
  - `/api/stats`: `dailyMacros: Record<MacroKey, Record<date, number>>` beside `daily` and `dailyProtein`

- [ ] **Step 1: Write the failing tests**

In `src/web/api.test.ts`:
- In `"adds daily_protein_goal beside daily_goal"`, change the expectation to:

```ts
    expect(api.getUser(USER)).toEqual({
      daily_goal: 2000,
      daily_protein_goal: 120,
      tracked_macros: ["protein"],
      username: "maria",
      analytics_id: null,
    })
```

- Add inside `describe("getUser")`:

```ts
  test("tracked_macros follows /settings, in registry order", () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["added_sugar", "fat"] })
    expect(api.getUser(USER).tracked_macros).toEqual(["fat", "added_sugar"])
  })
```

- In `"keep total and add protein, with protein_g on each item"`, change the items expectation to:

```ts
    expect(result.items).toEqual([
      { id: expect.any(Number), description: "Eggs", calories: 180, protein_g: 12, fat_g: null, fiber_g: null, added_sugar_g: null, emoji: "🍳" },
      { id: expect.any(Number), description: "Toast", calories: 150, protein_g: null, fat_g: null, fiber_g: null, added_sugar_g: null, emoji: "🍞" },
    ])
```

- Add inside `describe("getToday / getDay")`:

```ts
  test("add every macro's day total and per-item value", () => {
    foodLogsRepo.create(USER, 1, today, [
      { description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" },
      { description: "Rice", calories: 205, protein_g: 4, fat_g: 0, fiber_g: 1, added_sugar_g: 0, emoji: "🍚" },
    ])

    const result = api.getToday(USER)

    expect(result.total).toBe(625)
    expect(result.protein).toBe(42)
    expect(result.macros).toEqual({ protein: 42, fat: 24, fiber: 2, added_sugar: 2 })
    expect(result.items[0]).toMatchObject({ fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
  })
```

- Add inside `describe("getStats")`:

```ts
  test("adds dailyMacros per macro, aligned with daily", () => {
    foodLogsRepo.create(USER, 1, today, [{ description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 }])

    const stats = api.getStats(USER, "week")

    expect(Object.keys(stats.dailyMacros)).toEqual(["protein", "fat", "fiber", "added_sugar"])
    for (const series of Object.values(stats.dailyMacros)) expect(Object.keys(series)).toEqual(Object.keys(stats.daily))
    expect(stats.dailyMacros.added_sugar[today]).toBe(2)
    expect(stats.dailyMacros.fat[Object.keys(stats.daily).sort()[5]]).toBe(0)
  })
```

Create `src/web/app-page.test.ts`:

```ts
// src/web/app-page.test.ts
// The Mini App is one static HTML page, so nothing typechecks its script.
// These catch a syntax error and a macro the page has no label for.
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MACROS } from "../macros"

const html = readFileSync(join(import.meta.dir, "views/app.html"), "utf8")
// The page's own script: the <script> block without a src.
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).at(-1) ?? ""

describe("Mini App page", () => {
  test("has an inline script, and it parses", () => {
    expect(script.length).toBeGreaterThan(1000)
    expect(() => new Function(script)).not.toThrow()
  })

  test("labels every registry macro, with its column", () => {
    for (const m of MACROS) expect(script).toContain(`${m.key}: { column: '${m.column}',`)
  })

  test("builds the metric toggle from the user's macros", () => {
    expect(script).toContain("tracked_macros")
    expect(script).toContain("dailyMacros")
    expect(html).not.toContain('data-metric="protein"')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/web`
Expected: FAIL: no `tracked_macros`, `macros` or `dailyMacros` yet, and the page has no `MACRO_LABELS`.

- [ ] **Step 3: The API**

In `src/web/api.ts`:
- Add `import { MACROS, DEFAULT_MACROS, macroValuesOf, type MacroKey } from "../macros"`.
- Replace `dayPayload` with:

```ts
function dayPayload(date: string, entries: FoodLog[]) {
  const items = entries.flatMap((log) =>
    log.items.map((item) => ({
      id: item.id,
      description: item.description,
      calories: item.calories,
      ...macroValuesOf(item),
      emoji: item.emoji,
    }))
  )
  const { calories, ...macros } = sumTotals(items)
  return { date, total: calories, protein: macros.protein, macros, items }
}
```

- In `getUser`, add after `daily_protein_goal`:

```ts
        // Registry order. A Telegram-cached page that predates this ignores it.
        tracked_macros: user?.tracked_macros ?? [...DEFAULT_MACROS],
```

- In `getStats`, replace the fill loop and the return with:

```ts
      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      const dailyProtein: Record<string, number> = {}
      const dailyMacros = Object.fromEntries(MACROS.map((m) => [m.key, {}])) as Record<MacroKey, Record<string, number>>
      for (const date of dateRange) {
        const day = dailyTotals[date]
        daily[date] = day?.calories ?? 0
        dailyProtein[date] = day?.protein ?? 0
        for (const m of MACROS) dailyMacros[m.key][date] = day?.[m.key] ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
        dailyProtein,
        dailyMacros,
      }
```

- [ ] **Step 4: The page: styles and markup**

In `src/web/views/app.html`:

1. After the `.protein-bar-fill { … }` rule, add:

```css
    .protein-wrap.hidden,
    .macros-text.hidden,
    .segmented.hidden {
      display: none;
    }

    /* The other tracked macros, one line under the protein bar */
    .macros-text {
      font-size: 14px;
      color: var(--hint-color);
      text-align: center;
      max-width: 280px;
      margin: 0 auto 8px;
    }
```

2. Change the comment `/* Calories | Protein toggle */` to `/* Calories | each tracked macro */`.

3. After the `.food-name { … }` rule, add:

```css
    .food-macros {
      font-size: 13px;
      color: var(--hint-color);
    }
```

4. Replace the protein block in `#today-view`:

```html
    <div class="protein-wrap">
      <div class="protein-text" id="today-protein">--</div>
      <div class="protein-bar" id="today-protein-bar"><div class="protein-bar-fill" id="today-protein-fill"></div></div>
    </div>
```
with
```html
    <div class="protein-wrap" id="today-protein-wrap">
      <div class="protein-text" id="today-protein">--</div>
      <div class="protein-bar" id="today-protein-bar"><div class="protein-bar-fill" id="today-protein-fill"></div></div>
    </div>
    <div class="macros-text hidden" id="today-macros"></div>
```

5. Empty both segmented controls; the script fills them:

```html
    <div class="segmented" data-view="week">
      <button data-metric="calories" class="active">Calories</button>
      <button data-metric="protein">Protein</button>
    </div>
```
becomes
```html
    <div class="segmented" data-view="week"></div>
```
and the same for `data-view="month"`.

- [ ] **Step 5: The page: script**

In the `<script>` block of `src/web/views/app.html`:

1. Replace

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
with
```js
    // Which series the week/month charts show. Shared by both views on purpose.
    let metric = 'calories';

    // Every macro /api/user can list in tracked_macros, in the registry's
    // order (src/macros.ts; app-page.test.ts checks each key is here).
    const MACRO_LABELS = {
      protein: { column: 'protein_g', toggle: 'Protein', item: '', total: 'protein' },
      fat: { column: 'fat_g', toggle: 'Fat', item: 'fat', total: 'fat' },
      fiber: { column: 'fiber_g', toggle: 'Fiber', item: 'fiber', total: 'fiber' },
      added_sugar: { column: 'added_sugar_g', toggle: 'Sugar', item: 'sugar', total: 'added sugar' },
    };

    // The user's macros. A server that predates tracked_macros only knew protein.
    function trackedMacros() {
      const keys = (userData && userData.tracked_macros) || ['protein'];
      return keys.filter(key => key in MACRO_LABELS);
    }

    // `14 g`, `24 g fat`, `? g sugar`.
    function gramsText(value, label) {
      const grams = value === null || value === undefined ? '? g' : `${value} g`;
      return label ? `${grams} ${label}` : grams;
    }

    function metricSeries(data, key) {
      if (key === 'calories') return data.daily;
      if (data.dailyMacros && data.dailyMacros[key]) return data.dailyMacros[key];
      return key === 'protein' ? data.dailyProtein || {} : {};
    }

    // Only calories and protein have goals.
    function metricGoal(user, key) {
      if (key === 'calories') return user && user.daily_goal;
      if (key === 'protein') return user && user.daily_protein_goal;
      return null;
    }
```

2. Replace `renderFoodLog` from `const headerText = …` to the end of the function with:

```js
      const tracked = trackedMacros();
      const extras = tracked.filter(key => key !== 'protein');
      const headerText = date ? formatDate(date) : "Today's Log";
      const total = items.reduce((sum, item) => sum + item.calories, 0);
      const sumOf = key => items.reduce((sum, item) => {
        const value = item[MACRO_LABELS[key].column];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);

      const headerDiv = document.createElement('div');
      headerDiv.className = 'food-log-header';
      const parts = [`${total} cal`, ...tracked.map(key => `${sumOf(key)} g ${MACRO_LABELS[key].total}`)];
      headerDiv.textContent = `${headerText} • ${parts.join(' · ')}`;
      container.appendChild(headerDiv);

      items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'food-item';

        const emojiDiv = document.createElement('div');
        emojiDiv.className = 'food-emoji';
        emojiDiv.textContent = item.emoji || '🍴';

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'food-details';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'food-name';
        nameDiv.textContent = item.description; // Safe: textContent escapes HTML

        detailsDiv.appendChild(nameDiv);

        // Tracked macros other than protein go on a second line under the name.
        if (extras.length > 0) {
          const macrosDiv = document.createElement('div');
          macrosDiv.className = 'food-macros';
          macrosDiv.textContent = extras.map(key => gramsText(item[MACRO_LABELS[key].column], MACRO_LABELS[key].item)).join(' · ');
          detailsDiv.appendChild(macrosDiv);
        }

        const caloriesDiv = document.createElement('div');
        caloriesDiv.className = 'food-calories';
        caloriesDiv.textContent = tracked.includes('protein')
          ? `${item.calories} cal · ${gramsText(item.protein_g, '')}`
          : `${item.calories} cal`;

        itemDiv.appendChild(emojiDiv);
        itemDiv.appendChild(detailsDiv);
        itemDiv.appendChild(caloriesDiv);
        container.appendChild(itemDiv);
      });
    }
```

3. After `renderProteinBar`, add:

```js
    // Under the ring: the protein bar when protein is tracked, then one line
    // for any other tracked macros.
    function renderMacros(today, user) {
      const tracked = trackedMacros();
      const showProtein = tracked.includes('protein');
      document.getElementById('today-protein-wrap').classList.toggle('hidden', !showProtein);
      if (showProtein) renderProteinBar(today.protein || 0, user.daily_protein_goal);

      const totals = today.macros || {};
      const extras = tracked.filter(key => key !== 'protein');
      const line = document.getElementById('today-macros');
      line.textContent = extras.map(key => `${(totals[key] || 0).toLocaleString()} g ${MACRO_LABELS[key].total}`).join(' · ');
      line.classList.toggle('hidden', extras.length === 0);
    }
```

4. In `createWeekChart`, change `const series = METRICS[metric].series(data);` to `const series = metricSeries(data, metric);` and `const goal = METRICS[metric].goal(user);` to `const goal = metricGoal(user, metric);`. In `createMonthChart` and `createCalendar`, change `const series = METRICS[metric].series(data);` to `const series = metricSeries(data, metric);`.

5. Replace the whole toggle block:

```js
    // Calories | Protein toggle. One shared metric: switching on Week also
    // switches Month, so the two views never disagree.
    document.querySelectorAll('.segmented button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.metric !== metric) track('miniapp_metric_changed', { metric: btn.dataset.metric });
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
with
```js
    // Calories plus each tracked macro, hidden when there is nothing to switch
    // to. One shared metric: switching on Week also switches Month, so the two
    // views never disagree.
    function renderMetricToggles() {
      const keys = ['calories', ...trackedMacros()];
      if (!keys.includes(metric)) metric = 'calories';
      document.querySelectorAll('.segmented').forEach(group => {
        group.innerHTML = '';
        group.classList.toggle('hidden', keys.length < 2);
        for (const key of keys) {
          const btn = document.createElement('button');
          btn.dataset.metric = key;
          btn.textContent = key === 'calories' ? 'Calories' : MACRO_LABELS[key].toggle;
          btn.classList.toggle('active', key === metric);
          btn.addEventListener('click', () => selectMetric(key));
          group.appendChild(btn);
        }
      });
    }

    function selectMetric(key) {
      if (key !== metric) track('miniapp_metric_changed', { metric: key });
      metric = key;
      document.querySelectorAll('.segmented button').forEach(b => {
        b.classList.toggle('active', b.dataset.metric === metric);
      });
      if (weekData && userData) createWeekChart(weekData, userData, metric);
      if (monthData) {
        createMonthChart(monthData, metric);
        createCalendar(monthData, metric);
      }
    }
```

6. In `loadTabData`:
   - In the `today` branch, replace `renderProteinBar(today.protein || 0, user.daily_protein_goal);` with `renderMacros(today, user);`.
   - In the `week` branch, add `renderMetricToggles();` right before `createWeekChart(weekData, userData, metric);`.
   - In the `month` branch, add these two lines right after `if (!monthData) monthData = await api('/api/stats?period=month');`:

```js
          if (!userData) userData = await getUser();
          renderMetricToggles();
```

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: 0 fail; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat(web): Mini App and API show the user's macros" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Docs, landing page copy and live checks

**Files:**
- Modify: `src/web/views/landing.html`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- Test: `src/web/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no code; copy and documentation that match the shipped behaviour.

- [ ] **Step 1: Landing page copy, with a test**

Add inside `describe("routes")` in `src/web/server.test.ts`:

```ts
  test("/ says fat, fiber and added sugar can be switched on", async () => {
    const body = await (await get("/")).text()
    expect(body).toContain("Fat, fiber and added sugar can be switched on too.")
    expect(body).toContain("Calories, protein, fat, fiber and added sugar</li>")
  })
```

Run: `bun test src/web/server.test.ts`. Expected: FAIL.

In `src/web/views/landing.html`:
- Change `<p>Every item gets both, so you can hit a protein target as well as a calorie limit.</p>` to `<p>Every item gets both, so you can hit a protein target as well as a calorie limit. Fat, fiber and added sugar can be switched on too.</p>`.
- In the pricing list, change the item text `Calories and protein</li>` to `Calories, protein, fat, fiber and added sugar</li>`.

Leave everything else on the page (title, meta tags, hero, screenshots) as it is: it stays true with the protein-only default.

Run: `bun test src/web/server.test.ts`. Expected: PASS.

- [ ] **Step 2: README**

In `README.md`, replace each old line with the new one (line numbers are from before any edit).

Line 5:
```
Describe what you ate in natural language, and TeleCal estimates the calories and protein using AI (OpenAI, Anthropic, or Google Gemini).
```
→
```
Describe what you ate in natural language, and TeleCal estimates calories, protein, fat, fiber and added sugar using AI (OpenAI, Anthropic, or Google Gemini). Each user picks which macros their replies show.
```

Line 81:
```
| `/today` | View today's calories and protein |
```
→
```
| `/today` | View today's calories and macros |
```

Line 86:
```
| `/settings` | Change AI provider, calorie and protein goals, reminders |
```
→
```
| `/settings` | Change AI provider, calorie and protein goals, which macros to show, reminders |
```

Line 89: in the `/admin` row, change `backfill protein (admin only)` to `backfill macros (admin only)`.

Line 94:
```
`/settings` (OpenAI, Anthropic, or Google) to estimate calories and protein.
```
→
```
`/settings` (OpenAI, Anthropic, or Google) to estimate calories and macros.
```

Line 96:
```
The one-off `/admin backfill-protein` command sends the descriptions of items logged before protein tracking existed to the **admin's** selected provider, not each user's.
```
→
```
The one-off `/admin backfill-macros` command sends the descriptions of items with a macro still missing (logged before that macro existed, or skipped by the model) to the **admin's** selected provider, not each user's.
```

Line 141:
```
3. AI estimates calories and protein and may ask clarifying questions
```
→
```
3. AI estimates calories and macros and may ask clarifying questions
```

- [ ] **Step 3: CHANGELOG**

In `CHANGELOG.md`, add as the first bullet under `## [Unreleased]` → `### Added`:

```markdown
- **Fat, fiber and added sugar.** Every estimate now includes them beside
  protein, and `/settings` → Macros switches each one on or off per user
  (protein on and the rest off by default, so nobody's replies change until
  they choose). Switched-on macros appear on item lines and totals, in
  `/today`, in the `/week` and `/month` totals, in reminders and in the Mini
  App (a line under the protein bar, a second line per item, and a toggle per
  macro on the Week and Month charts). `/edit` sets any of them by name
  (`3g sugar`, `24g fat`); a bare `18g` still sets protein.
  `/admin backfill-protein` is now `/admin backfill-macros`, which fills every
  missing macro on older items without overwriting values already there.
  `/api/user` gains `tracked_macros`; days gain `macros` and per-item
  `fat_g`, `fiber_g` and `added_sugar_g`; stats gain `dailyMacros`.
```

- [ ] **Step 4: CLAUDE.md**

In `CLAUDE.md`:
- In Commands, change `bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]   # one live API call to verify a provider; --protein exercises the batch call; with POSTHOG_* set, also sends the $ai_generation` to `bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--macros]   # one live API call to verify a provider; --macros exercises the batch call; with POSTHOG_* set, also sends the $ai_generation`.
- Under `### Key Components`, add before `**AI Service** (`src/ai/`):`:

```markdown
**Macros** (`src/macros.ts`): the registry of tracked macros (protein, fat, fiber, added sugar), with each one's column, labels, `/edit` words and prompt rule. Prompts, parsing, the cache check, repository SQL, formatters, the backfill, `/settings` and the API loop over it; nothing else names a macro. Calories are not in it. Each user's choice is `users.tracked_macros`; formatters take that list (`DEFAULT_MACROS` is protein only).
```

- Under **AI Service**, replace
  ```
  - Caching uses `estimation_cache` table keyed by normalized food description
  ```
  with
  ```
  - Caching uses `estimation_cache` table keyed by normalized food description; an entry counts only if every macro is a number
  ```
- Under **Background Jobs**, replace the `backfill-protein.ts` line with
  ```
  - `backfill-macros.ts` - Fills every missing macro (null cells only), 25 descriptions per AI call; run via `/admin backfill-macros`
  ```
- Under **Database Tables**, replace the `users` and `food_logs` / `food_items` lines with
  ```
  - `users` - User preferences (ai_provider, daily_goal, daily_protein_goal, tracked_macros, reminder_time, analytics_content)
  - `food_logs` / `food_items` - Log sessions and individual items (`calories`, nullable `protein_g`, `fat_g`, `fiber_g`, `added_sugar_g`)
  ```

- [ ] **Step 5: Live and full checks**

Run each and record the output in your report:

```bash
bun test                       # expect 0 fail
bunx tsc --noEmit              # expect no output
bunx tsc --noEmit --ignoreConfig --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types bun-types scripts/telegram-mock/render.ts scripts/smoke-providers.ts   # expect no output
bun run scripts/smoke-providers.ts gemini            # expect "✓ gemini responded" and every item with all four macros
bun run scripts/smoke-providers.ts gemini --macros   # expect "✓ gemini responded to estimateMacros" and four values per line
bun run scripts/telegram-mock/render.ts              # expect three "wrote scripts/screenshots/shot-*.png" lines
grep -rn -E "backfill-protein|estimateProtein|PROTEIN_RULE|PROTEIN_BATCH_PROMPT|coerceProtein|alignProteinBatch|runProteinBackfill|formatProtein" src scripts README.md CLAUDE.md   # expect no output
```

The smoke script makes two live Gemini calls (about $0.001 in total). `render.ts` writes only to the gitignored `scripts/screenshots/`. Do **not** run `scripts/build-landing-assets.sh`: the committed screenshots stay as they are. If a smoke call fails for network or quota reasons, report it rather than retrying in a loop.

- [ ] **Step 6: Commit**

```bash
git add src README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: fat, fiber and added sugar in the README, changelog, CLAUDE.md and landing page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Report what needs a human**

These cannot be done from here; list them in the task report:
- The test-bot check (needs the separate test bot token and a tunnel): log a meal with all four macros switched on, open `/settings` → Macros and toggle, send `/today`, `/week` and `/edit 1` then `3g sugar`, and open the Mini App (Today line, Week toggle per macro, a day's second line).
- After merge and deploy: run `/admin backfill-macros` once in production and paste its two replies into #30 and #10.

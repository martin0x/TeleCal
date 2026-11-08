# Food Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each user keeps a library of saved foods with label values per serving. `/log` uses those values instead of AI guesses, and skips the AI entirely when a meal is made only of saved foods.

**Architecture:** A new `src/library/` module holds pure matching (`match.ts`), validation, previews and `MealEstimator`, which becomes the single entry point for meal estimates (used by `LogFlow` and the retry job). Foods are added in chat (`/foods`: paste a table, `/foods add`, or "Save to my foods" on a logged meal), always through a preview with a Save button. They are browsed, edited and deleted in a new Mini App Foods tab backed by the Mini App's first write endpoints. Everything sits behind the existing `FEATURE_LOCAL_FOOD_DB` flag.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, grammY, `bun test`; OpenAI Responses API, Anthropic Messages API, Gemini; a static HTML/JS Mini App.

**Spec:** `docs/superpowers/specs/2026-11-08-food-library-design.md` (read it before starting; this plan argues from it). Issue #32; post-deploy stress test #31.

## Global Constraints

- Work on branch `feat/food-library`. Never push to `main` (pushing `main` deploys prod).
- Gate: `bun test` passes after every task. There is no typecheck script; do not add one.
- Feature flag: `config.features.localFoodDb` (`FEATURE_LOCAL_FOOD_DB`, default `false`). Read it only where objects are built (`src/bot/index.ts`, `src/index.ts`, `src/bot/help.ts`) and pass it in as `enabled` / `foodLibrary` / `foodLibraryEnabled`. Library code never reads `config` itself.
- With the flag off, every reply and every AI call must be byte-identical to today's. The system prompts and OpenAI's default estimate schema must not change.
- Limits, verbatim from the spec: calories 0–5000 per serving; each macro 0–500 g per serving; name 1–100 characters; at most 15 saved foods in a prompt; `DELETE /api/foods` takes 1–500 ids.
- Copy, verbatim: "Paste one food or a whole table. Values per serving." / "Couldn't read that right now. Try again in a bit." / "This preview expired, paste again." / "Open me in a private chat to manage your foods." / "These are already in your foods." / "Save to your foods? Values are per serving, as logged." / "No saved foods yet. Use /foods in the chat to add some." / "From your foods: …".
- No new emoji in bot replies or in the web UI (the existing ✓ toggle mark, used by `/settings` → Macros, is allowed).
- Send every bot reply through `smartReply` / `smartEdit` (`src/bot/utils/smart-reply.ts`).
- Web API changes are additive only: never rename or reshape an existing field (Telegram caches `app.html`).
- Analytics events carry counts and labels only, never food names or values.
- The Mini App script must not use `?.` or `??` (it runs in old Telegram webviews; the existing script uses neither). Put user text into the DOM with `textContent`, never `innerHTML`.
- End every commit message with this trailer, verbatim (do not swap in another model name):
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/utils/normalize.ts` | new | `normalizeFoodText` (moved from `AIService`), `foodWords`, `normalizeFoodName` |
| `src/library/types.ts` | new | `FoodFields`, `SavedFood`, `ServingUnit`, `FoodSource` |
| `src/library/validate.ts` | new | `validateFood`: the one gate for anything entering the library |
| `src/library/match.ts` | new | Pure matching: `matchMeal`, `candidatesFor`, `scaleFood`, helpers |
| `src/library/estimator.ts` | new | `MealEstimator`, `applyLabels` |
| `src/library/preview.ts` | new | `importPreview`, `logPreview`, `formatFoodLine`, `formatPreview` |
| `src/db/repositories/food-library.ts` | new | `FoodLibraryRepository` |
| `src/bot/commands/foods.ts` | new | `/foods` hub, add flow, previews, Save, save-from-log |
| `src/db/schema.sql`, `src/db/migrations.ts` | modify | `food_library` table; `food_items.saved_food_id` |
| `src/db/repositories/food-logs.ts` | modify | write `saved_food_id`; `getItemsByLog` |
| `src/ai/types.ts`, `prompt.ts`, `parse.ts`, `service.ts`, `providers/*.ts` | modify | saved foods in the estimate call; `parseFoods` |
| `src/bot/conversations/log-flow.ts` | modify | uses `MealEstimator`; footer; `saveOffer` |
| `src/bot/commands/log.ts` | modify | "Save to my foods" button |
| `src/bot/utils/callback-data.ts` | modify | `foods:` callbacks |
| `src/bot/index.ts`, `src/index.ts` | modify | wiring |
| `src/jobs/retry-pending.ts` | modify | uses `MealEstimator` |
| `src/web/api.ts`, `src/web/server.ts` | modify | `/api/foods` routes; `food_library` in `/api/user` |
| `src/web/views/app.html` | modify | Foods tab |
| `scripts/smoke-providers.ts` | modify | `--foods` |
| `src/bot/help.ts`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `.env.example` | modify | docs |

---

### Task 1: Food text normalization, library types and validation

**Files:**
- Create: `src/utils/normalize.ts`, `src/utils/normalize.test.ts`
- Create: `src/library/types.ts`
- Create: `src/library/validate.ts`, `src/library/validate.test.ts`
- Modify: `src/ai/service.ts` (remove private `normalizeFood`, use `normalizeFoodText`)

**Interfaces:**
- Produces:
  - `normalizeFoodText(food: string): string`, the `estimation_cache` key, unchanged behaviour
  - `foodWords(text: string): string[]`
  - `normalizeFoodName(name: string): string`
  - `type ServingUnit = "g" | "ml"`, `type FoodSource = "import" | "single" | "log"`
  - `type FoodFields = { name; serving; serving_amount: number | null; serving_unit: ServingUnit | null; calories: number } & Record<MacroColumn, number | null>`
  - `type SavedFood = FoodFields & { id: number; telegram_id: number; source: FoodSource }`
  - `validateFood(input: Record<string, unknown>): { ok: true; food: FoodFields } | { ok: false; reason: string }`
  - constants `MAX_FOOD_CALORIES = 5000`, `MAX_FOOD_GRAMS = 500`, `MAX_NAME_LENGTH = 100`, `MAX_SERVING_LENGTH = 100`, `DEFAULT_SERVING = "1 serving"`, `AS_LOGGED = "as logged"`

- [ ] **Step 1: Write the failing tests**

`src/utils/normalize.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { normalizeFoodText, foodWords, normalizeFoodName } from "./normalize"

describe("normalizeFoodText", () => {
  test("is the estimation_cache key it replaces, unchanged", () => {
    expect(normalizeFoodText("  Chicken   Adobo! ")).toBe("chicken adobo")
    // Spaces collapse before punctuation is stripped, so "&" leaves two spaces.
    expect(normalizeFoodText("2 eggs & toast")).toBe("2 eggs  toast")
  })
})

describe("foodWords / normalizeFoodName", () => {
  test("split on any whitespace and drop punctuation", () => {
    expect(foodWords("Mac & Cheese!")).toEqual(["mac", "cheese"])
    expect(normalizeFoodName("  Quaker   Oats! ")).toBe("quaker oats")
    expect(normalizeFoodName("!!!")).toBe("")
  })
})
```

`src/library/validate.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { validateFood, DEFAULT_SERVING, MAX_FOOD_CALORIES, MAX_FOOD_GRAMS } from "./validate"

const ROW = {
  name: "Quaker Oats",
  serving: "1/2 cup (40 g)",
  serving_amount: 40,
  serving_unit: "g",
  calories: 150,
  protein_g: 5,
  fat_g: 3,
  fiber_g: 4,
  added_sugar_g: null,
}

function reason(input: Record<string, unknown>): string | null {
  const result = validateFood(input)
  return result.ok ? null : result.reason
}

function food(input: Record<string, unknown>) {
  const result = validateFood(input)
  if (!result.ok) throw new Error(result.reason)
  return result.food
}

describe("validateFood", () => {
  test("accepts a full label row as is", () => {
    expect(food(ROW)).toEqual(ROW)
  })

  test("tidies the name and requires one", () => {
    expect(food({ ...ROW, name: "  Quaker   Oats " }).name).toBe("Quaker Oats")
    expect(reason({ ...ROW, name: "" })).toBe("no name")
    expect(reason({ ...ROW, name: "!!!" })).toBe("no name")
    expect(reason({ ...ROW, name: 42 })).toBe("no name")
    expect(reason({ ...ROW, name: "x".repeat(101) })).toBe("name too long")
  })

  test("requires calories in range, rounding decimals and reading numeric strings", () => {
    expect(reason({ ...ROW, calories: undefined })).toBe("no calories")
    expect(reason({ ...ROW, calories: "n/a" })).toBe("no calories")
    expect(food({ ...ROW, calories: "150" }).calories).toBe(150)
    expect(food({ ...ROW, calories: 150.6 }).calories).toBe(151)
    expect(food({ ...ROW, calories: MAX_FOOD_CALORIES }).calories).toBe(5000)
    expect(reason({ ...ROW, calories: 5001 })).toBe("calories out of range")
    expect(reason({ ...ROW, calories: -1 })).toBe("calories out of range")
  })

  test("macros: blank means not on the label; one decimal place kept; range checked", () => {
    expect(food({ ...ROW, fat_g: 0.5 }).fat_g).toBe(0.5)
    expect(food({ ...ROW, fat_g: 0.55 }).fat_g).toBe(0.6)
    expect(food({ ...ROW, fiber_g: "" }).fiber_g).toBeNull()
    expect(food({ ...ROW, fiber_g: undefined }).fiber_g).toBeNull()
    expect(food({ ...ROW, fiber_g: "trace" }).fiber_g).toBeNull()
    expect(food({ ...ROW, protein_g: MAX_FOOD_GRAMS }).protein_g).toBe(500)
    expect(reason({ ...ROW, protein_g: 500.1 })).toBe("protein out of range")
    expect(reason({ ...ROW, added_sugar_g: -2 })).toBe("added sugar out of range")
  })

  test("a missing serving becomes 1 serving; a long one is cut to 100 characters", () => {
    expect(food({ ...ROW, serving: "" }).serving).toBe(DEFAULT_SERVING)
    expect(food({ ...ROW, serving: undefined }).serving).toBe(DEFAULT_SERVING)
    expect(food({ ...ROW, serving: "y".repeat(150) }).serving).toHaveLength(100)
  })

  test("a serving amount needs a positive number and a g or ml unit, else both are null", () => {
    expect(food({ ...ROW, serving_unit: "grams" })).toMatchObject({ serving_amount: 40, serving_unit: "g" })
    expect(food({ ...ROW, serving_amount: 250, serving_unit: "mL" })).toMatchObject({ serving_amount: 250, serving_unit: "ml" })
    expect(food({ ...ROW, serving_unit: null })).toMatchObject({ serving_amount: null, serving_unit: null })
    expect(food({ ...ROW, serving_unit: "cup" })).toMatchObject({ serving_amount: null, serving_unit: null })
    expect(food({ ...ROW, serving_amount: 0 })).toMatchObject({ serving_amount: null, serving_unit: null })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/utils/normalize.test.ts src/library/validate.test.ts`
Expected: FAIL, "Cannot find module './normalize'" and "Cannot find module './validate'".

- [ ] **Step 3: Implement**

`src/utils/normalize.ts`:

```ts
// src/utils/normalize.ts
// Food text as the estimation cache and the food library compare it.

/** Lowercase, trimmed, single-spaced, punctuation stripped. The estimation_cache key: never change it. */
export function normalizeFoodText(food: string): string {
  return food
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
}

/** "Mac & Cheese!" → ["mac", "cheese"]. */
export function foodWords(text: string): string[] {
  return normalizeFoodText(text).split(/\s+/).filter(Boolean)
}

/** A saved food's key: its words joined by single spaces. "Quaker  Oats!" → "quaker oats". */
export function normalizeFoodName(name: string): string {
  return foodWords(name).join(" ")
}
```

`src/library/types.ts`:

```ts
// src/library/types.ts
import type { MacroColumn } from "../macros"

export type ServingUnit = "g" | "ml"
export type FoodSource = "import" | "single" | "log"

/** What a user saves: label values per serving. Macros in grams, decimals allowed; null = not on the label. */
export type FoodFields = {
  name: string
  serving: string
  /** Only together with serving_unit; both null when the label gives no amount. */
  serving_amount: number | null
  serving_unit: ServingUnit | null
  calories: number
} & Record<MacroColumn, number | null>

/** A row of food_library. */
export type SavedFood = FoodFields & {
  id: number
  telegram_id: number
  source: FoodSource
}
```

`src/library/validate.ts`:

```ts
// src/library/validate.ts
// One gate for every way a food enters the library: a parsed paste, a logged
// item and a Mini App edit. Input is untrusted (model output or a request body).
import { MACROS, type MacroColumn } from "../macros"
import { normalizeFoodName } from "../utils/normalize"
import type { FoodFields, ServingUnit } from "./types"

export const MAX_FOOD_CALORIES = 5000
export const MAX_FOOD_GRAMS = 500
export const MAX_NAME_LENGTH = 100
export const MAX_SERVING_LENGTH = 100
/** The serving of a row that gave none. */
export const DEFAULT_SERVING = "1 serving"
/** The serving of a food saved from a log: one serving is what was logged. */
export const AS_LOGGED = "as logged"

export type Validation = { ok: true; food: FoodFields } | { ok: false; reason: string }

/** A finite number from a number or numeric string; null for anything else, "" included. */
function toNumber(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof num === "number" && Number.isFinite(num) ? num : null
}

function toUnit(value: unknown): ServingUnit | null {
  if (typeof value !== "string") return null
  const unit = value.trim().toLowerCase()
  if (unit === "g" || unit === "gram" || unit === "grams") return "g"
  if (unit === "ml") return "ml"
  return null
}

export function validateFood(input: Record<string, unknown>): Validation {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : ""
  if (!normalizeFoodName(name)) return { ok: false, reason: "no name" }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name too long" }

  const rawCalories = toNumber(input.calories)
  if (rawCalories === null) return { ok: false, reason: "no calories" }
  const calories = Math.round(rawCalories)
  if (calories < 0 || calories > MAX_FOOD_CALORIES) return { ok: false, reason: "calories out of range" }

  const macros = {} as Record<MacroColumn, number | null>
  for (const m of MACROS) {
    const value = toNumber(input[m.column])
    if (value !== null && (value < 0 || value > MAX_FOOD_GRAMS)) {
      return { ok: false, reason: `${m.totalLabel} out of range` }
    }
    macros[m.column] = value === null ? null : Math.round(value * 10) / 10
  }

  const servingText = typeof input.serving === "string" ? input.serving.trim().replace(/\s+/g, " ") : ""
  const serving = (servingText || DEFAULT_SERVING).slice(0, MAX_SERVING_LENGTH)

  const amount = toNumber(input.serving_amount)
  const unit = toUnit(input.serving_unit)
  const hasAmount = amount !== null && amount > 0 && unit !== null

  return {
    ok: true,
    food: {
      name,
      serving,
      serving_amount: hasAmount ? amount : null,
      serving_unit: hasAmount ? unit : null,
      calories,
      ...macros,
    },
  }
}
```

In `src/ai/service.ts`: add `import { normalizeFoodText } from "../utils/normalize"`, change `const normalizedFood = this.normalizeFood(foodDescription)` to `const normalizedFood = normalizeFoodText(foodDescription)`, and delete the private `normalizeFood` method.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/utils src/library src/ai`
Expected: PASS (the cache tests in `service.test.ts` prove the key is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/utils/normalize.ts src/utils/normalize.test.ts src/library/types.ts src/library/validate.ts src/library/validate.test.ts src/ai/service.ts
git commit -m "$(cat <<'EOF'
feat(library): food types, validation and shared food-text normalizing (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `food_library` table, repository, and `saved_food_id` on food items

**Files:**
- Modify: `src/db/schema.sql`, `src/db/migrations.ts`, `src/db/migrations.test.ts`
- Create: `src/db/repositories/food-library.ts`, `src/db/repositories/food-library.test.ts`
- Modify: `src/db/repositories/food-logs.ts`, `src/db/repositories/food-logs.test.ts`

**Interfaces:**
- Consumes: `FoodFields`, `SavedFood`, `FoodSource` (Task 1); `normalizeFoodName` (Task 1)
- Produces:
  - `class FoodLibraryRepository(db: Database)` with:
    - `listByUser(telegramId): SavedFood[]` (A–Z, ignoring case)
    - `get(telegramId, id): SavedFood | null`
    - `count(telegramId): number`
    - `upsertMany(telegramId, foods: FoodFields[], source: FoodSource): { added: number; replaced: number }`
    - `update(telegramId, id, food: FoodFields): "ok" | "not_found" | "name_taken"`
    - `deleteMany(telegramId, ids: number[]): number | "not_found"`
  - `FoodItem` gains `saved_food_id?: number | null`
  - `FoodLogsRepository.getItemsByLog(telegramId, logId): FoodItem[] | null`

- [ ] **Step 1: Write the failing tests**

`src/db/repositories/food-library.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { FoodLibraryRepository } from "./food-library"
import type { FoodFields } from "../../library/types"

const USER = 42
const OTHER = 99

function fields(overrides: Partial<FoodFields> = {}): FoodFields {
  return {
    name: "Quaker Oats",
    serving: "1/2 cup (40 g)",
    serving_amount: 40,
    serving_unit: "g",
    calories: 150,
    protein_g: 5,
    fat_g: 3,
    fiber_g: 4,
    added_sugar_g: null,
    ...overrides,
  }
}

let repo: FoodLibraryRepository

beforeEach(() => {
  repo = new FoodLibraryRepository(createTestDb())
})

describe("FoodLibraryRepository", () => {
  test("upsertMany adds foods and lists them A–Z ignoring case", () => {
    const result = repo.upsertMany(
      USER,
      [fields({ name: "skyflakes" }), fields({ name: "Quaker Oats" }), fields({ name: "banana" })],
      "import"
    )
    expect(result).toEqual({ added: 3, replaced: 0 })
    const foods = repo.listByUser(USER)
    expect(foods.map((f) => f.name)).toEqual(["banana", "Quaker Oats", "skyflakes"])
    expect(foods[1]).toMatchObject({ ...fields(), telegram_id: USER, source: "import" })
    expect(repo.count(USER)).toBe(3)
  })

  test("a name that matches ignoring case and punctuation replaces the saved food", () => {
    repo.upsertMany(USER, [fields()], "import")
    const result = repo.upsertMany(USER, [fields({ name: "quaker oats!", calories: 160 })], "single")
    expect(result).toEqual({ added: 0, replaced: 1 })
    const [only, ...rest] = repo.listByUser(USER)
    expect(rest).toHaveLength(0)
    expect(only).toMatchObject({ name: "quaker oats!", calories: 160, source: "single" })
  })

  test("keeps decimal macros", () => {
    repo.upsertMany(USER, [fields({ fat_g: 0.5 })], "import")
    expect(repo.listByUser(USER)[0].fat_g).toBe(0.5)
  })

  test("everything is scoped to its owner", () => {
    repo.upsertMany(USER, [fields()], "import")
    const id = repo.listByUser(USER)[0].id
    expect(repo.listByUser(OTHER)).toEqual([])
    expect(repo.count(OTHER)).toBe(0)
    expect(repo.get(OTHER, id)).toBeNull()
    expect(repo.get(USER, id)?.name).toBe("Quaker Oats")
  })

  test("update changes a food, refuses another user's, and refuses a name already taken", () => {
    repo.upsertMany(USER, [fields(), fields({ name: "Skyflakes", calories: 110 })], "import")
    const [oats, skyflakes] = repo.listByUser(USER)

    expect(repo.update(USER, oats.id, fields({ calories: 160 }))).toBe("ok")
    expect(repo.get(USER, oats.id)?.calories).toBe(160)

    expect(repo.update(OTHER, oats.id, fields({ calories: 1 }))).toBe("not_found")
    expect(repo.update(USER, skyflakes.id, fields({ name: "QUAKER OATS" }))).toBe("name_taken")
    expect(repo.get(USER, skyflakes.id)?.name).toBe("Skyflakes")
  })

  test("deleteMany deletes the user's foods, all or nothing", () => {
    repo.upsertMany(USER, [fields(), fields({ name: "Skyflakes" })], "import")
    repo.upsertMany(OTHER, [fields({ name: "Banana" })], "import")
    const [oats, skyflakes] = repo.listByUser(USER)
    const banana = repo.listByUser(OTHER)[0]

    expect(repo.deleteMany(USER, [oats.id, banana.id])).toBe("not_found")
    expect(repo.count(USER)).toBe(2)
    expect(repo.count(OTHER)).toBe(1)

    expect(repo.deleteMany(USER, [oats.id, oats.id, skyflakes.id])).toBe(2)
    expect(repo.count(USER)).toBe(0)
    expect(repo.deleteMany(USER, [])).toBe(0)
  })
})
```

Append to `src/db/repositories/food-logs.test.ts`, inside the existing `describe("FoodLogsRepository", ...)` block (its `beforeEach` creates `repo` and users 1 and 123):

```ts
  test("stores saved_food_id with an item; null when not given", () => {
    const log = repo.create(123, 1, "2026-01-31", [
      { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 7 },
      { description: "Banana", calories: 105 },
    ])
    expect(log.items.map((i) => i.saved_food_id)).toEqual([7, null])
  })

  test("getItemsByLog returns a log's items to its owner only", () => {
    const log = repo.create(123, 1, "2026-01-31", [{ description: "Banana", calories: 105 }])
    expect(repo.getItemsByLog(123, log.id)?.map((i) => i.description)).toEqual(["Banana"])
    expect(repo.getItemsByLog(1, log.id)).toBeNull()
    expect(repo.getItemsByLog(123, 424242)).toBeNull()
  })
```

Append to `src/db/migrations.test.ts`:

```ts
describe("saved_food_id", () => {
  test("is added to an existing food_items", () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE food_items (id INTEGER PRIMARY KEY, log_id INTEGER, description TEXT, calories INTEGER)")
    runMigrations(
      db,
      COLUMN_MIGRATIONS.filter((m) => m.table === "food_items"),
      () => {}
    )
    expect(hasColumn(db, "food_items", "saved_food_id")).toBe(true)
  })
})
```

and change that file's import line to `import { runMigrations, hasColumn, COLUMN_MIGRATIONS } from "./migrations"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/db`
Expected: FAIL. `./food-library` is missing, `saved_food_id` comes back `undefined`, `getItemsByLog` is not a function, and the migration test fails.

- [ ] **Step 3: Implement**

In `src/db/schema.sql`, add `saved_food_id` to `food_items` (after the `emoji TEXT,` line, before the `FOREIGN KEY`):

```sql
  -- The saved food this item came from (food_library.id); null = not from the library.
  -- No foreign key: values are copied at log time, so a deleted food leaves a harmless dangling id.
  saved_food_id INTEGER,
```

Then add the table after `food_items`:

```sql
-- A user's saved foods: label values per serving (/foods, Mini App Foods tab)
CREATE TABLE IF NOT EXISTS food_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,   -- normalizeFoodName(name); matching and duplicates
  serving TEXT NOT NULL,           -- the label's wording, e.g. '1/2 cup (40 g)'
  serving_amount REAL,             -- 40; null when the label gives no amount
  serving_unit TEXT,               -- 'g' | 'ml'; null exactly when serving_amount is
  calories INTEGER NOT NULL,       -- per serving
  protein_g REAL,                  -- per serving; null = not on the label
  fat_g REAL,
  fiber_g REAL,
  added_sugar_g REAL,
  source TEXT NOT NULL,            -- import | single | log
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (telegram_id, normalized_name)
);
```

In `src/db/migrations.ts`, append to `COLUMN_MIGRATIONS`:

```ts
  { table: "food_items", column: "saved_food_id", ddl: "INTEGER" },
```

`src/db/repositories/food-library.ts`:

```ts
// src/db/repositories/food-library.ts
import { Database } from "bun:sqlite"
import { MACROS } from "../../macros"
import { normalizeFoodName } from "../../utils/normalize"
import type { FoodFields, FoodSource, SavedFood } from "../../library/types"

const MACRO_COLUMNS = MACROS.map((m) => m.column)
/** Every column a save writes, in fieldValues order. Built from registry constants, never from input. */
const FIELD_COLUMNS = ["name", "normalized_name", "serving", "serving_amount", "serving_unit", "calories", ...MACRO_COLUMNS]
const SELECT_COLUMNS = `id, telegram_id, source, name, serving, serving_amount, serving_unit, calories, ${MACRO_COLUMNS.join(", ")}`

function fieldValues(food: FoodFields): (string | number | null)[] {
  return [
    food.name,
    normalizeFoodName(food.name),
    food.serving,
    food.serving_amount,
    food.serving_unit,
    food.calories,
    ...MACRO_COLUMNS.map((column) => food[column]),
  ]
}

export class FoodLibraryRepository {
  constructor(private db: Database) {}

  /** A–Z by name, ignoring case. */
  listByUser(telegramId: number): SavedFood[] {
    return this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM food_library WHERE telegram_id = ? ORDER BY name COLLATE NOCASE, id`)
      .all(telegramId) as SavedFood[]
  }

  get(telegramId: number, id: number): SavedFood | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM food_library WHERE telegram_id = ? AND id = ?`)
      .get(telegramId, id) as SavedFood | null
    return row ?? null
  }

  count(telegramId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM food_library WHERE telegram_id = ?").get(telegramId) as {
      n: number
    }
    return row.n
  }

  /** Saves each food, replacing a saved one with the same name (ignoring case and punctuation). One transaction. */
  upsertMany(telegramId: number, foods: FoodFields[], source: FoodSource): { added: number; replaced: number } {
    const exists = this.db.prepare("SELECT 1 FROM food_library WHERE telegram_id = ? AND normalized_name = ?")
    const upsert = this.db.prepare(`
      INSERT INTO food_library (telegram_id, source, ${FIELD_COLUMNS.join(", ")})
      VALUES (?, ?, ${FIELD_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT (telegram_id, normalized_name) DO UPDATE SET
        ${FIELD_COLUMNS.filter((c) => c !== "normalized_name").map((c) => `${c} = excluded.${c}`).join(", ")},
        source = excluded.source,
        updated_at = datetime('now')
    `)
    let added = 0
    let replaced = 0
    this.db.transaction(() => {
      for (const food of foods) {
        if (exists.get(telegramId, normalizeFoodName(food.name))) replaced++
        else added++
        upsert.run(telegramId, source, ...fieldValues(food))
      }
    })()
    return { added, replaced }
  }

  update(telegramId: number, id: number, food: FoodFields): "ok" | "not_found" | "name_taken" {
    if (!this.get(telegramId, id)) return "not_found"
    const clash = this.db
      .prepare("SELECT 1 FROM food_library WHERE telegram_id = ? AND normalized_name = ? AND id != ?")
      .get(telegramId, normalizeFoodName(food.name), id)
    if (clash) return "name_taken"
    this.db
      .prepare(
        `UPDATE food_library SET ${FIELD_COLUMNS.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now')
         WHERE telegram_id = ? AND id = ?`
      )
      .run(...fieldValues(food), telegramId, id)
    return "ok"
  }

  /** All or nothing: if any id is not this user's, nothing is deleted. */
  deleteMany(telegramId: number, ids: number[]): number | "not_found" {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return 0
    const placeholders = unique.map(() => "?").join(", ")
    return this.db.transaction((): number | "not_found" => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM food_library WHERE telegram_id = ? AND id IN (${placeholders})`)
        .get(telegramId, ...unique) as { n: number }
      if (row.n !== unique.length) return "not_found"
      this.db.prepare(`DELETE FROM food_library WHERE telegram_id = ? AND id IN (${placeholders})`).run(telegramId, ...unique)
      return unique.length
    })()
  }
}
```

In `src/db/repositories/food-logs.ts`:

1. Add the field to `FoodItem`:

```ts
export type FoodItem = {
  id?: number
  description: string
  calories: number
  emoji?: string
  /** The saved food this item came from; null or missing = not from the library. */
  saved_food_id?: number | null
} & Partial<Record<MacroColumn, number | null>>
```

2. Add `saved_food_id: number | null` to `FoodItemRow`:

```ts
type FoodItemRow = {
  id: number
  description: string
  calories: number
  emoji: string | null
  saved_food_id: number | null
} & Record<MacroColumn, number | null>
```

3. In `create`, write the column:

```ts
    const itemStmt = this.db.prepare(`
      INSERT INTO food_items (log_id, description, calories, ${MACRO_COLUMNS.join(", ")}, emoji, saved_food_id)
      VALUES (?, ?, ?, ${MACRO_COLUMNS.map(() => "?").join(", ")}, ?, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        ...MACRO_COLUMNS.map((column) => item[column] ?? null),
        item.emoji ?? null,
        item.saved_food_id ?? null
      ) as FoodItemRow
      return { ...row, emoji: row.emoji ?? undefined }
    })
```

4. Add after `getByDate`:

```ts
  /** A log's items, or null when the log does not exist or is not this user's. */
  getItemsByLog(telegramId: number, logId: number): FoodItem[] | null {
    const log = this.db.prepare("SELECT id FROM food_logs WHERE id = ? AND telegram_id = ?").get(logId, telegramId)
    if (!log) return null
    const rows = this.db.prepare("SELECT * FROM food_items WHERE log_id = ? ORDER BY id").all(logId) as FoodItemRow[]
    return rows.map((row) => ({ ...row, emoji: row.emoji ?? undefined }))
  }
```

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS. If an existing `toEqual` on a full food item row fails only because rows now carry `saved_food_id: null`, add `saved_food_id: null` to that expectation and nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrations.ts src/db/migrations.test.ts src/db/repositories/food-library.ts src/db/repositories/food-library.test.ts src/db/repositories/food-logs.ts src/db/repositories/food-logs.test.ts
git commit -m "$(cat <<'EOF'
feat(db): food_library table and repository; saved_food_id on food items (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Matching meals in code

**Files:**
- Create: `src/library/match.ts`, `src/library/match.test.ts`

**Interfaces:**
- Consumes: `SavedFood`, `ServingUnit` (Task 1); `foodWords`, `normalizeFoodName` (Task 1); `FoodEstimate` from `src/ai/types.ts`. Task 4 adds `saved_food_id` to `FoodEstimate`; until then, `scaleFood`'s `as FoodEstimate` cast covers it.
- Produces:
  - `type Quantity = { kind: "servings"; n: number } | { kind: "amount"; value: number; unit: ServingUnit }`
  - `type MatchedItem = { food: SavedFood; servings: number }`
  - `parseQuantity(part: string): { quantity: Quantity; rest: string } | null`
  - `findFood(text: string, foods: SavedFood[]): SavedFood | null`
  - `servingsFor(food: SavedFood, quantity: Quantity): number | null`
  - `splitMeal(text: string): string[]`
  - `matchMeal(text: string, foods: SavedFood[]): MatchedItem[] | null`
  - `scaleFood(food: SavedFood, servings: number): FoodEstimate`, which sets `saved_food_id`
  - `MAX_CANDIDATES = 15`
  - `candidatesFor(text: string, foods: SavedFood[], limit = MAX_CANDIDATES): SavedFood[]`

- [ ] **Step 1: Write the failing tests**

`src/library/match.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { candidatesFor, matchMeal, parseQuantity, scaleFood, splitMeal } from "./match"
import type { SavedFood } from "./types"

function food(overrides: Partial<SavedFood> & Pick<SavedFood, "id" | "name">): SavedFood {
  return {
    telegram_id: 42,
    source: "import",
    serving: "1 serving",
    serving_amount: null,
    serving_unit: null,
    calories: 100,
    protein_g: null,
    fat_g: null,
    fiber_g: null,
    added_sugar_g: null,
    ...overrides,
  }
}

const OATS = food({ id: 1, name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4 })
const MILK = food({ id: 2, name: "Nestle Fresh Milk", serving: "1 cup (250 ml)", serving_amount: 250, serving_unit: "ml", calories: 160, protein_g: 8, fat_g: 9, fiber_g: 0, added_sugar_g: 0 })
const SKYFLAKES = food({ id: 3, name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 0.5, added_sugar_g: 1 })
const MAC = food({ id: 4, name: "Mac and cheese", serving: "1 cup", calories: 380, protein_g: 14 })
const HALF_MOON = food({ id: 5, name: "Half Moon Cake", calories: 210 })
const LIBRARY = [OATS, MILK, SKYFLAKES, MAC, HALF_MOON]

/** [food id, servings] per matched item, or null. */
function match(text: string, foods = LIBRARY) {
  const items = matchMeal(text, foods)
  return items && items.map((i) => [i.food.id, i.servings])
}

describe("matchMeal: code-only path", () => {
  test.each([
    ["quaker oats", [[1, 1]]],
    ["Quaker Oats!", [[1, 1]]],
    ["oats", [[1, 1]]],
    ["2 oats", [[1, 2]]],
    ["2x oats", [[1, 2]]],
    ["oats x2", [[1, 2]]],
    ["oats ×2", [[1, 2]]],
    ["1/2 oats", [[1, 0.5]]],
    ["0.5 oats", [[1, 0.5]]],
    ["half oats", [[1, 0.5]]],
    ["2 servings oats", [[1, 2]]],
    ["2 servings of oats", [[1, 2]]],
    ["a skyflakes", [[3, 1]]],
    ["80g oats", [[1, 2]]],
    ["80 g oats", [[1, 2]]],
    ["80 grams of oats", [[1, 2]]],
    ["oats 80g", [[1, 2]]],
    ["250ml fresh milk", [[2, 1]]],
    ["500 ml milk", [[2, 2]]],
    ["2 skyflakes, 250ml fresh milk", [[3, 2], [2, 1]]],
    ["oats and milk", [[1, 1], [2, 1]]],
    ["oats + milk", [[1, 1], [2, 1]]],
    ["oats & milk", [[1, 1], [2, 1]]],
    ["oats\nmilk", [[1, 1], [2, 1]]],
    ["mac and cheese", [[4, 1]]],
    ["half moon cake", [[5, 1]]],
  ] as const)("%p", (text, expected) => {
    expect(match(text)).toEqual(expected as unknown as number[][])
  })

  test.each([
    "oats and a banana", // banana is not saved
    "a bowl of oats", // "bowl" can't be scaled
    "100ml oats", // unit mismatch: oats are weighed
    "100g mac and cheese", // no serving amount to scale by
    "2 cups mac and cheese",
    "0 oats",
    "rice",
  ])("%p goes to the AI", (text) => {
    expect(matchMeal(text, LIBRARY)).toBeNull()
  })

  test("two foods containing every typed word is ambiguous, but an exact name still wins", () => {
    const library = [...LIBRARY, food({ id: 6, name: "Quaker Oats Instant" })]
    expect(matchMeal("oats", library)).toBeNull()
    expect(match("quaker oats", library)).toEqual([[1, 1]])
  })

  test("an empty library matches nothing", () => {
    expect(matchMeal("oats", [])).toBeNull()
  })
})

describe("parseQuantity / splitMeal", () => {
  test("no quantity means one serving of the whole text", () => {
    expect(parseQuantity("Quaker Oats")).toEqual({ quantity: { kind: "servings", n: 1 }, rest: "quaker oats" })
  })

  test("an unusable quantity is null", () => {
    expect(parseQuantity("0 oats")).toBeNull()
    expect(parseQuantity("1/0 oats")).toBeNull()
  })

  test("splits on commas, plus, ampersand, 'and' and new lines, not inside words", () => {
    expect(splitMeal("2 skyflakes, milk + oats & rice and beans\nsandwich")).toEqual([
      "2 skyflakes",
      "milk",
      "oats",
      "rice",
      "beans",
      "sandwich",
    ])
  })
})

describe("scaleFood", () => {
  test("multiplies label values and rounds; blanks stay null", () => {
    expect(scaleFood(OATS, 2)).toEqual({
      description: "Quaker Oats ×2",
      calories: 300,
      protein_g: 10,
      fat_g: 6,
      fiber_g: 8,
      added_sugar_g: null,
      saved_food_id: 1,
    })
  })

  test("one serving keeps the plain name; 3 × 0.5 g fat logs as 2 g", () => {
    expect(scaleFood(SKYFLAKES, 1).description).toBe("Skyflakes")
    expect(scaleFood(SKYFLAKES, 3).fat_g).toBe(2)
    expect(scaleFood(SKYFLAKES, 1 / 3).description).toBe("Skyflakes ×0.33")
  })
})

describe("candidatesFor", () => {
  test("picks saved foods sharing a meaningful word", () => {
    expect(candidatesFor("80g oats and a banana", LIBRARY).map((f) => f.id)).toEqual([1])
    expect(candidatesFor("rice", LIBRARY)).toEqual([])
    expect(candidatesFor("2 servings of", LIBRARY)).toEqual([])
  })

  test("ranks by shared words, then shorter names", () => {
    const tea = food({ id: 7, name: "Milk Tea" })
    expect(candidatesFor("fresh milk", [tea, MILK]).map((f) => f.id)).toEqual([2, 7])
  })

  test("caps at 15", () => {
    const many = Array.from({ length: 20 }, (_, i) => food({ id: 100 + i, name: `Chicken ${i}` }))
    expect(candidatesFor("chicken", many)).toHaveLength(15)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/library/match.test.ts`
Expected: FAIL with "Cannot find module './match'".

- [ ] **Step 3: Implement**

`src/library/match.ts`:

```ts
// src/library/match.ts
// Matching a meal against a user's saved foods, in code. Pure: no database,
// no AI. matchMeal decides whether a log can skip the AI entirely;
// candidatesFor picks the saved foods worth showing the AI otherwise.
import { MACROS } from "../macros"
import type { FoodEstimate } from "../ai/types"
import { foodWords, normalizeFoodName } from "../utils/normalize"
import type { SavedFood, ServingUnit } from "./types"

export type Quantity = { kind: "servings"; n: number } | { kind: "amount"; value: number; unit: ServingUnit }
export type MatchedItem = { food: SavedFood; servings: number }

export const MAX_CANDIDATES = 15

const NUMBER = String.raw`(\d+(?:\.\d+)?)`
const UNIT = String.raw`(g|grams?|ml)`
const SERVINGS_WORD = String.raw`(?:servings?\s+(?:of\s+)?)?`
const WORD_QUANTITIES: Record<string, number> = { a: 1, an: 1, one: 1, half: 0.5 }

const LEADING_AMOUNT = new RegExp(`^${NUMBER}\\s*${UNIT}\\s+(?:of\\s+)?(.+)$`)
const LEADING_FRACTION = new RegExp(`^(\\d+)\\/(\\d+)\\s+${SERVINGS_WORD}(.+)$`)
const LEADING_COUNT = new RegExp(`^[x×]?${NUMBER}\\s*[x×]?\\s+${SERVINGS_WORD}(.+)$`)
const LEADING_WORD = new RegExp(`^(a|an|one|half)\\s+${SERVINGS_WORD}(.+)$`)
const TRAILING_AMOUNT = new RegExp(`^(.+?)\\s+${NUMBER}\\s*${UNIT}$`)
const TRAILING_COUNT = new RegExp(`^(.+?)\\s+[x×]\\s*${NUMBER}$`)
const TRAILING_COUNT_X = new RegExp(`^(.+?)\\s+${NUMBER}\\s*[x×]$`)

/** Short and quantity words that say nothing about which food is meant. */
const IGNORED_WORDS = new Set(["and", "with", "the", "gram", "grams", "cup", "cups", "serving", "servings", "piece", "pieces", "pcs"])

function unitOf(text: string): ServingUnit {
  return text === "ml" ? "ml" : "g"
}

function servings(n: number): Quantity | null {
  return Number.isFinite(n) && n > 0 ? { kind: "servings", n } : null
}

/**
 * Splits a quantity off the start or end of one part of a meal: "2x oats",
 * "oats x2", "1/2 oats", "half oats", "80g oats", "oats 80 g". No quantity
 * means one serving. Null when a quantity is there but unusable ("0 oats").
 */
export function parseQuantity(part: string): { quantity: Quantity; rest: string } | null {
  const text = part.trim().toLowerCase().replace(/\s+/g, " ")
  let m: RegExpMatchArray | null

  if ((m = text.match(LEADING_AMOUNT))) {
    const value = Number(m[1])
    return value > 0 ? { quantity: { kind: "amount", value, unit: unitOf(m[2]) }, rest: m[3] } : null
  }
  if ((m = text.match(LEADING_FRACTION))) {
    const q = servings(Number(m[1]) / Number(m[2]))
    return q ? { quantity: q, rest: m[3] } : null
  }
  if ((m = text.match(LEADING_COUNT))) {
    const q = servings(Number(m[1]))
    return q ? { quantity: q, rest: m[2] } : null
  }
  if ((m = text.match(LEADING_WORD))) {
    return { quantity: { kind: "servings", n: WORD_QUANTITIES[m[1]] }, rest: m[2] }
  }
  if ((m = text.match(TRAILING_AMOUNT))) {
    const value = Number(m[2])
    return value > 0 ? { quantity: { kind: "amount", value, unit: unitOf(m[3]) }, rest: m[1] } : null
  }
  if ((m = text.match(TRAILING_COUNT)) || (m = text.match(TRAILING_COUNT_X))) {
    const q = servings(Number(m[2]))
    return q ? { quantity: q, rest: m[1] } : null
  }
  return { quantity: { kind: "servings", n: 1 }, rest: text }
}

function exactFood(text: string, foods: SavedFood[]): SavedFood | null {
  const key = normalizeFoodName(text)
  if (!key) return null
  return foods.find((f) => normalizeFoodName(f.name) === key) ?? null
}

/** The one saved food this text names: an exact name first, then the only food containing every word typed. */
export function findFood(text: string, foods: SavedFood[]): SavedFood | null {
  const exact = exactFood(text, foods)
  if (exact) return exact
  const words = normalizeFoodName(text).split(" ").filter(Boolean)
  if (words.length === 0) return null
  const hits = foods.filter((f) => {
    const names = new Set(foodWords(f.name))
    return words.every((w) => names.has(w))
  })
  return hits.length === 1 ? hits[0] : null
}

/** How many servings a quantity is of this food; null when code can't tell (unit mismatch, no serving amount). */
export function servingsFor(food: SavedFood, quantity: Quantity): number | null {
  if (quantity.kind === "servings") return quantity.n
  if (food.serving_amount === null || food.serving_unit !== quantity.unit) return null
  return quantity.value / food.serving_amount
}

/** "2 skyflakes, milk and oats" → ["2 skyflakes", "milk", "oats"]. */
export function splitMeal(text: string): string[] {
  return text
    .split(/\s*(?:,|\+|&|\n|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
}

function matchPart(part: string, foods: SavedFood[]): MatchedItem | null {
  // A name that starts like a quantity ("Half Moon Cake") wins as a whole.
  const exact = exactFood(part, foods)
  if (exact) return { food: exact, servings: 1 }
  const parsed = parseQuantity(part)
  if (!parsed) return null
  const food = findFood(parsed.rest, foods)
  if (!food) return null
  const count = servingsFor(food, parsed.quantity)
  return count === null ? null : { food, servings: count }
}

/**
 * Every part of the meal as a saved food and a number of servings, or null if
 * any part can't be matched and scaled in code. The whole text is tried as one
 * food first, so a saved "Mac and cheese" is not split in two.
 */
export function matchMeal(text: string, foods: SavedFood[]): MatchedItem[] | null {
  if (foods.length === 0) return null
  const whole = matchPart(text, foods)
  if (whole) return [whole]
  const parts = splitMeal(text)
  if (parts.length < 2) return null
  const items: MatchedItem[] = []
  for (const part of parts) {
    const item = matchPart(part, foods)
    if (!item) return null
    items.push(item)
  }
  return items
}

function formatServings(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** A saved food as a logged item: label values times servings, rounded. Blanks stay null. */
export function scaleFood(food: SavedFood, servings: number): FoodEstimate {
  const item = {
    description: servings === 1 ? food.name : `${food.name} ×${formatServings(servings)}`,
    calories: Math.round(food.calories * servings),
    saved_food_id: food.id,
  } as FoodEstimate
  for (const m of MACROS) {
    const value = food[m.column]
    item[m.column] = value === null ? null : Math.round(value * servings)
  }
  return item
}

function meaningfulWords(text: string): string[] {
  return foodWords(text).filter((w) => w.length >= 3 && !/^\d/.test(w) && !IGNORED_WORDS.has(w))
}

/** Up to `limit` saved foods sharing a word with the text: most shared words first, then shorter names. */
export function candidatesFor(text: string, foods: SavedFood[], limit = MAX_CANDIDATES): SavedFood[] {
  const wanted = new Set(meaningfulWords(text))
  if (wanted.size === 0) return []
  const scored = foods
    .map((food) => {
      let score = 0
      for (const w of new Set(meaningfulWords(food.name))) if (wanted.has(w)) score++
      return { food, score }
    })
    .filter((s) => s.score > 0)
  scored.sort(
    (a, b) => b.score - a.score || a.food.name.length - b.food.name.length || a.food.name.localeCompare(b.food.name)
  )
  return scored.slice(0, limit).map((s) => s.food)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/library/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/match.ts src/library/match.test.ts
git commit -m "$(cat <<'EOF'
feat(library): match meals against saved foods in code (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Saved foods in the estimate call

**Files:**
- Modify: `src/ai/types.ts`, `src/ai/prompt.ts`, `src/ai/parse.ts`, `src/ai/service.ts`
- Modify: `src/ai/providers/anthropic.ts`, `gemini.ts`, `openai.ts`
- Test: `src/ai/prompt.test.ts`, `src/ai/parse.test.ts`, `src/ai/service.test.ts`, `src/ai/providers/anthropic.test.ts`, `gemini.test.ts`, `openai.test.ts`

**Interfaces:**
- Consumes: `SavedFood` (Task 1)
- Produces:
  - `FoodEstimate` gains `saved_food_id?: number | null` and `servings?: number | null`
  - `EstimationResult` gains `cached?: true`
  - `AIProvider.estimate(foodDescription: string, context?: string, savedFoods?: string)`
  - `EstimateOptions` gains `savedFoods?: SavedFood[]`
  - `estimateUserMessage(foodDescription: string, context?: string, savedFoods?: string): string` in `prompt.ts`
  - `formatSavedFoods(foods: SavedFood[]): string` in `prompt.ts`
  - `SAVED_FOODS_HEADER` in `prompt.ts`
  - Behaviour: a non-empty `savedFoods` means the block goes into the user message and the shared cache is neither read nor written. A cache hit returns `{ ...cached, cached: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/ai/prompt.test.ts` (and add `estimateUserMessage, formatSavedFoods, SAVED_FOODS_HEADER` to its import from `./prompt`):

```ts
describe("saved foods", () => {
  const OATS = {
    id: 12,
    telegram_id: 42,
    source: "import" as const,
    name: "Quaker Oats",
    serving: "1/2 cup (40 g)",
    serving_amount: 40,
    serving_unit: "g" as const,
    calories: 150,
    protein_g: 5,
    fat_g: 3,
    fiber_g: 4,
    added_sugar_g: null,
  }

  test("formatSavedFoods lists each food's label values and asks for saved_food_id and servings", () => {
    const block = formatSavedFoods([OATS])
    expect(block.split("\n")[0]).toBe(SAVED_FOODS_HEADER)
    expect(block).toContain(
      "[12] Quaker Oats, serving 1/2 cup (40 g): 150 kcal, protein 5 g, fat 3 g, fiber 4 g, added sugar not on label"
    )
    expect(block).toContain("saved_food_id")
    expect(block).toContain("servings")
  })

  test("estimateUserMessage is unchanged without saved foods, and appends them otherwise", () => {
    expect(estimateUserMessage("oats")).toBe("oats")
    expect(estimateUserMessage("oats", "Original input: \"x\"")).toBe(
      "Context from previous conversation: Original input: \"x\"\n\nFood to estimate: oats"
    )
    expect(estimateUserMessage("oats", undefined, "BLOCK")).toBe("oats\n\nBLOCK")
  })

  test("the system prompt does not mention saved foods", () => {
    expect(ESTIMATE_JSON_PROMPT).not.toContain("saved_food_id")
  })
})
```

Append to `src/ai/parse.test.ts`:

```ts
describe("normalizeItems: saved foods", () => {
  test("keeps saved_food_id and servings when the model sent them, coercing bad values to null", () => {
    const [a, b, c] = normalizeItems([
      { description: "Oats", calories: 300, saved_food_id: 12, servings: 2 },
      { description: "Banana", calories: 105, saved_food_id: null, servings: null },
      { description: "Rice", calories: 200, saved_food_id: "7", servings: -1 },
    ])
    expect([a.saved_food_id, a.servings]).toEqual([12, 2])
    expect([b.saved_food_id, b.servings]).toEqual([null, null])
    expect([c.saved_food_id, c.servings]).toEqual([7, null])
  })

  test("adds neither field when the model did not send them", () => {
    const [item] = normalizeItems([{ description: "Eggs", calories: 180 }])
    expect("saved_food_id" in item).toBe(false)
    expect("servings" in item).toBe(false)
  })
})
```

Append to `src/ai/service.test.ts`:

```ts
describe("saved foods", () => {
  const OATS = {
    id: 1,
    telegram_id: 42,
    source: "import" as const,
    name: "Quaker Oats",
    serving: "1/2 cup (40 g)",
    serving_amount: 40,
    serving_unit: "g" as const,
    calories: 150,
    protein_g: 5,
    fat_g: 3,
    fiber_g: 4,
    added_sugar_g: null,
  }

  test("go to the provider in the third argument, and the shared cache is neither read nor written", async () => {
    cache.set("oats", ESTIMATE)
    const seen: unknown[][] = []
    const provider: AIProvider = {
      name: "openai",
      estimate: async (...args: unknown[]) => {
        seen.push(args)
        return OK_RESULT
      },
      estimateMacros: async () => {
        throw new Error("not used")
      },
      parseFoods: async () => {
        throw new Error("not used")
      },
    }
    service = build(provider)

    const result = await service.estimate("oats", "openai", { ...OPTS, savedFoods: [OATS] })

    expect(result.cached).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(String(seen[0][2])).toContain("[1] Quaker Oats")
    expect([...cache.store.keys()]).toEqual(["oats"])
    expect(cache.store.get("oats")).toEqual(ESTIMATE)
  })

  test("an empty list behaves as no saved foods", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("chicken adobo", "openai", { ...OPTS, savedFoods: [] })
    expect(cache.store.has("chicken adobo")).toBe(true)
  })
})
```

In the same file, change the existing "writes no row on a cache hit" assertion from `expect(result).toEqual(ESTIMATE)` to `expect(result).toEqual({ ...ESTIMATE, cached: true })`. Also add `parseFoods: async () => { throw new Error("not used in this test") },` to the object `fakeProvider` returns.

Append to `src/ai/providers/anthropic.test.ts` (add `SAVED_FOODS_HEADER` to its `../prompt` import):

```ts
describe("AnthropicProvider: saved foods", () => {
  function capturingClient(text: string) {
    const calls: any[] = []
    const client = {
      messages: {
        create: async (params: any) => {
          calls.push(params)
          return { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }
        },
      },
    } as unknown as Anthropic
    return { client, calls }
  }

  test("puts saved foods in the user message and leaves the system prompt alone", async () => {
    const { client, calls } = capturingClient(VALID_REPLY)
    await new AnthropicProvider(client).estimate("oats", undefined, `${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
    expect(calls[0].system).toBe(ESTIMATE_JSON_PROMPT)
    expect(calls[0].messages[0].content).toBe(`oats\n\n${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
  })

  test("keeps the saved_food_id and servings the model returns", async () => {
    const reply = JSON.stringify({
      items: [{ description: "Oats", calories: 300, saved_food_id: 1, servings: 2, emoji: "🥣" }],
      needsClarification: false,
      confidence: "high",
    })
    const { client } = capturingClient(reply)
    const result = await new AnthropicProvider(client).estimate("80g oats", undefined, SAVED_FOODS_HEADER)
    expect(result.estimate.items[0]).toMatchObject({ saved_food_id: 1, servings: 2 })
  })
})
```

Append to `src/ai/providers/gemini.test.ts` (add `SAVED_FOODS_HEADER` to its `../prompt` import):

```ts
describe("GeminiProvider: saved foods", () => {
  test("puts saved foods in the user message and leaves the system prompt alone", async () => {
    const seen: { system?: string; input?: string } = {}
    const client = {
      getGenerativeModel: (opts: any) => {
        seen.system = opts.systemInstruction
        return {
          generateContent: async (input: string) => {
            seen.input = input
            return { response: { text: () => VALID_REPLY, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } }
          },
        }
      },
    } as any
    await new GeminiProvider(client).estimate("oats", undefined, `${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
    expect(seen.system).toBe(ESTIMATE_JSON_PROMPT)
    expect(seen.input).toBe(`oats\n\n${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
  })
})
```

Append to `src/ai/providers/openai.test.ts` (add `SAVED_FOODS_HEADER` to its `../prompt` import):

```ts
describe("OpenAIProvider: saved foods", () => {
  test("uses the plain schema without saved foods", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("oats")
    const item = calls[0].text.format.schema.properties.items.items
    expect(item.required).not.toContain("saved_food_id")
    expect(calls[0].input).toBe("oats")
  })

  test("with saved foods: the block in the input, and a schema with nullable saved_food_id and servings", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("oats", undefined, `${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
    const item = calls[0].text.format.schema.properties.items.items
    expect(item.required).toEqual(expect.arrayContaining(["saved_food_id", "servings"]))
    expect(item.properties.saved_food_id).toEqual({ type: ["integer", "null"] })
    expect(item.properties.servings).toEqual({ type: ["number", "null"] })
    expect(calls[0].input).toBe(`oats\n\n${SAVED_FOODS_HEADER}\n[1] Quaker Oats`)
    expect(calls[0].text.format.strict).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/ai`
Expected: FAIL. `formatSavedFoods` and `SAVED_FOODS_HEADER` are not exported, `saved_food_id` is dropped, and the cache-hit result lacks `cached`.

- [ ] **Step 3: Implement**

`src/ai/types.ts`: replace `FoodEstimate`, `EstimationResult` and `AIProvider.estimate`:

```ts
/** One estimated item. Macro columns are whole grams; null when the model gave nothing usable (the backfill fills it later). */
export type FoodEstimate = {
  description: string
  calories: number
  emoji?: string
  /** The saved food this item is (code-only match, or the AI picked it from the saved foods it was shown). */
  saved_food_id?: number | null
  /** Provider output only: how many servings of saved_food_id. MealEstimator consumes it; it is never stored. */
  servings?: number | null
} & Record<MacroColumn, number | null>

export interface EstimationResult {
  items: FoodEstimate[]
  needsClarification: boolean
  clarificationQuestion?: string
  confidence: "high" | "medium" | "low"
  /** Set by AIService when the answer came from estimation_cache (nothing billed). */
  cached?: true
}
```

and in `AIProvider`:

```ts
  /** savedFoods: formatSavedFoods output, appended to the user message. */
  estimate(foodDescription: string, context?: string, savedFoods?: string): Promise<ProviderResult>
```

`src/ai/prompt.ts`: add `import type { SavedFood } from "../library/types"` and append:

```ts
/** The user message for an estimate: the food, with clarification context before it and saved foods after. */
export function estimateUserMessage(foodDescription: string, context?: string, savedFoods?: string): string {
  const base = context
    ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
    : foodDescription
  return savedFoods ? `${base}\n\n${savedFoods}` : base
}

export const SAVED_FOODS_HEADER = "Saved foods (the user's own label values, per serving):"

function labelValue(value: number | null, name: string): string {
  return value === null ? `${name} not on label` : `${name} ${value} g`
}

/**
 * The saved-foods block. It goes in the user message, never the system
 * prompt, so the system prompt stays identical across users (provider prompt
 * caching) and calls without saved foods stay byte-identical. It carries its
 * own instructions for the two extra fields.
 */
export function formatSavedFoods(foods: SavedFood[]): string {
  const lines = foods.map(
    (f) =>
      `[${f.id}] ${f.name}, serving ${f.serving}: ${f.calories} kcal, ` +
      MACROS.map((m) => labelValue(f[m.column], m.totalLabel)).join(", ")
  )
  return [
    SAVED_FOODS_HEADER,
    ...lines,
    "",
    "Add two fields to every item. If the item is one of these saved foods: saved_food_id is its number in brackets, " +
      "and servings is how many servings were eaten (convert the amount eaten using the serving size; 1 when no amount is given). " +
      "Otherwise both are null. Still give your own estimate for every other field.",
  ].join("\n")
}
```

`src/ai/parse.ts`: add two helpers and extend `normalizeItems`:

```ts
/** A positive whole number (a saved food's id), from a number or digit string; else null. */
function coerceId(value: unknown): number | null {
  const num = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof num === "number" && Number.isSafeInteger(num) && num > 0 ? num : null
}

/** A positive finite number of servings; else null. */
function coerceServings(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof num === "number" && Number.isFinite(num) && num > 0 ? num : null
}

/** Items from a parsed estimate, every macro column coerced. Non-arrays become []. */
export function normalizeItems(items: unknown): FoodEstimate[] {
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((raw) => ({
      ...(raw as unknown as FoodEstimate),
      ...(Object.fromEntries(MACROS.map((m) => [m.column, coerceGrams(raw[m.column])])) as MacroValues),
      // Only when the model sent them (saved foods were in the message), so other items keep today's shape.
      ...("saved_food_id" in raw ? { saved_food_id: coerceId(raw.saved_food_id) } : {}),
      ...("servings" in raw ? { servings: coerceServings(raw.servings) } : {}),
    }))
}
```

Providers: in `anthropic.ts` and `gemini.ts`, import `estimateUserMessage` from `../prompt` and change `estimate` to:

```ts
  async estimate(foodDescription: string, context?: string, savedFoods?: string): Promise<ProviderResult> {
    const userMessage = estimateUserMessage(foodDescription, context, savedFoods)
```

The rest of each method is unchanged.

In `openai.ts`: import `estimateUserMessage` from `../prompt`, and replace the `ESTIMATE_SCHEMA` constant with:

```ts
const ESTIMATE_ITEM_PROPERTIES = {
  description: { type: "string" },
  calories: { type: "number" },
  ...MACRO_PROPERTIES,
  emoji: { type: "string" },
}
const ESTIMATE_ITEM_REQUIRED = ["description", "calories", ...MACRO_COLUMNS, "emoji"]

function estimateSchema(itemProperties: Record<string, unknown>, itemRequired: string[]) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: itemProperties, required: itemRequired, additionalProperties: false },
      },
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["items", "needsClarification", "clarificationQuestion", "confidence"],
    additionalProperties: false,
  }
}

/**
 * Strict Structured Outputs requires every property to appear in `required`
 * and `additionalProperties: false` on every object. Fields that are
 * conceptually optional (clarificationQuestion, emoji) are therefore required
 * here and filled with an empty string when not applicable — see INSTRUCTIONS.
 */
const ESTIMATE_SCHEMA = estimateSchema(ESTIMATE_ITEM_PROPERTIES, ESTIMATE_ITEM_REQUIRED)

/** With saved foods in the message: the same, plus saved_food_id and servings, nullable so strict mode allows null. */
const ESTIMATE_WITH_SAVED_SCHEMA = estimateSchema(
  {
    ...ESTIMATE_ITEM_PROPERTIES,
    saved_food_id: { type: ["integer", "null"] },
    servings: { type: ["number", "null"] },
  },
  [...ESTIMATE_ITEM_REQUIRED, "saved_food_id", "servings"]
)
```

and in `estimate`:

```ts
  async estimate(foodDescription: string, context?: string, savedFoods?: string): Promise<ProviderResult> {
    const userMessage = estimateUserMessage(foodDescription, context, savedFoods)
```

and in its `text.format`, use `schema: savedFoods ? ESTIMATE_WITH_SAVED_SCHEMA : ESTIMATE_SCHEMA,`.

`src/ai/service.ts`:

```ts
import { formatSavedFoods } from "./prompt"
import type { SavedFood } from "../library/types"

export interface EstimateOptions {
  telegramId: number
  chatId: number | null
  callType: CallType
  context?: string
  /** The user's saved foods relevant to this message. Non-empty: shown to the AI, and the shared cache is skipped. */
  savedFoods?: SavedFood[]
}
```

Replace `estimate` and `estimateWithProvider`:

```ts
  async estimate(
    foodDescription: string,
    providerName: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    const normalizedFood = normalizeFoodText(foodDescription)
    const savedFoods = opts.savedFoods && opts.savedFoods.length > 0 ? formatSavedFoods(opts.savedFoods) : undefined
    // The shared cache holds generic answers. With this user's labels involved,
    // a hit would ignore them and a write would leak them to other users.
    const useCache = !opts.context && !savedFoods && config.features.caching

    if (useCache) {
      const cached = this.cache.get(normalizedFood)
      if (cached && isCurrentShape(cached)) return { ...cached, cached: true } // nothing billed, nothing recorded
    }

    const provider = this.resolveProvider(providerName)
    return this.estimateWithProvider(provider, foodDescription, normalizedFood, opts, { savedFoods, useCache })
  }
```

```ts
  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    opts: EstimateOptions,
    call: { savedFoods?: string; useCache: boolean }
  ): Promise<EstimationResult> {
    let result
    const started = performance.now()
    try {
      result = await provider.estimate(foodDescription, opts.context, call.savedFoods)
    } catch (error) {
      this.recordFailure(error, provider.name, opts, performance.now() - started)
      throw error
    }

    this.recordSafely(provider.name, result.usage, opts, this.statusFor(result.usage), {
      trace: result.trace,
      latencyMs: performance.now() - started,
    })

    const estimate = result.estimate
    // A result with an unknown macro is not worth keeping: the next ask should
    // get another chance at a complete answer.
    if (!estimate.needsClarification && call.useCache && isCurrentShape(estimate)) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }
```

`AIProvider` doesn't gain `parseFoods` until Task 5. The `parseFoods` stubs added to the test fakes in Step 1 are harmless before then.

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS. The existing OpenAI tests prove the default schema and message are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/ai
git commit -m "$(cat <<'EOF'
feat(ai): saved foods in the estimate's user message; shared cache skipped for them (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Parsing a pasted table (`parseFoods`)

**Files:**
- Modify: `src/ai/types.ts`, `src/ai/prompt.ts`, `src/ai/parse.ts`, `src/ai/service.ts`, `src/ai/providers/*.ts`
- Modify: `scripts/smoke-providers.ts`
- Test: `src/ai/prompt.test.ts`, `src/ai/parse.test.ts`, `src/ai/service.test.ts`, `src/ai/providers/*.test.ts`

**Interfaces:**
- Produces:
  - `type ParsedFoodsReply = { foods: Record<string, unknown>[]; unreadable: { text: string; reason: string }[] }`
  - `interface FoodsParseResult { reply: ParsedFoodsReply; usage: TokenUsage; trace?: AITrace }`
  - `AIProvider.parseFoods(text: string): Promise<FoodsParseResult>`
  - `CallType` gains `"import"`
  - `FOODS_PARSE_PROMPT`, `FOODS_MAX_TOKENS = 4096` in `prompt.ts`
  - `normalizeFoodsReply(reply: unknown): ParsedFoodsReply` in `parse.ts`
  - `AIService.parseFoods(text: string, providerName: string, opts: BatchOptions): Promise<ParsedFoodsReply>`, which records `ai_usage` with `call_type = "import"` and sends `$ai_generation`

- [ ] **Step 1: Write the failing tests**

Append to `src/ai/prompt.test.ts` (add `FOODS_PARSE_PROMPT` to the import):

```ts
describe("FOODS_PARSE_PROMPT", () => {
  test("asks for every macro column, per serving, never invented", () => {
    for (const m of MACROS) expect(FOODS_PARSE_PROMPT).toContain(`"${m.column}":`)
    expect(FOODS_PARSE_PROMPT).toContain("per serving")
    expect(FOODS_PARSE_PROMPT).toContain("Never estimate")
    expect(FOODS_PARSE_PROMPT).toContain("total sugars")
  })
})
```

Append to `src/ai/parse.test.ts` (add `normalizeFoodsReply` to the import):

```ts
describe("normalizeFoodsReply", () => {
  test("keeps object rows raw and turns unreadable entries into strings", () => {
    expect(
      normalizeFoodsReply({
        foods: [{ name: "Oats", calories: 150 }, "junk", null],
        unreadable: [{ text: "lunch adobo", reason: "no calories" }, { text: "" }, { text: 7 }],
      })
    ).toEqual({
      foods: [{ name: "Oats", calories: 150 }],
      unreadable: [
        { text: "lunch adobo", reason: "no calories" },
        { text: "7", reason: "unreadable" },
      ],
    })
  })

  test("anything else becomes empty lists", () => {
    expect(normalizeFoodsReply(null)).toEqual({ foods: [], unreadable: [] })
    expect(normalizeFoodsReply({ foods: "x" })).toEqual({ foods: [], unreadable: [] })
  })
})
```

Append to `src/ai/providers/anthropic.test.ts` (add `FOODS_PARSE_PROMPT` to the `../prompt` import):

```ts
describe("AnthropicProvider.parseFoods", () => {
  test("sends the text with the foods prompt and a 4096-token limit, and returns the rows", async () => {
    const calls: any[] = []
    const reply = JSON.stringify({ foods: [{ name: "Oats", calories: 150 }], unreadable: [] })
    const client = {
      messages: {
        create: async (params: any) => {
          calls.push(params)
          return { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: reply }], usage: { input_tokens: 50, output_tokens: 20 } }
        },
      },
    } as unknown as Anthropic

    const result = await new AnthropicProvider(client).parseFoods("Oats 150 kcal")

    expect(calls[0].system).toBe(FOODS_PARSE_PROMPT)
    expect(calls[0].max_tokens).toBe(4096)
    expect(calls[0].messages[0].content).toBe("Oats 150 kcal")
    expect(result.reply.foods).toEqual([{ name: "Oats", calories: 150 }])
    expect(result.usage.inputTokens).toBe(50)
  })

  test("bad JSON throws ProviderParseError", async () => {
    await expect(new AnthropicProvider(fakeClient("not json")).parseFoods("x")).rejects.toBeInstanceOf(ProviderParseError)
  })
})
```

Append to `src/ai/providers/gemini.test.ts`:

```ts
describe("GeminiProvider.parseFoods", () => {
  test("returns the rows", async () => {
    const reply = JSON.stringify({ foods: [{ name: "Oats", calories: 150 }], unreadable: [] })
    const result = await new GeminiProvider(fakeClient(reply)).parseFoods("Oats 150 kcal")
    expect(result.reply.foods).toEqual([{ name: "Oats", calories: 150 }])
  })
})
```

Append to `src/ai/providers/openai.test.ts`:

```ts
describe("OpenAIProvider.parseFoods", () => {
  test("uses a strict foods schema and a 4096-token limit", async () => {
    const reply = JSON.stringify({ foods: [{ name: "Oats", calories: 150 }], unreadable: [] })
    const { client, calls } = fakeClient(reply)
    const result = await new OpenAIProvider(client).parseFoods("Oats 150 kcal")
    expect(calls[0].text.format).toMatchObject({ type: "json_schema", name: "foods", strict: true })
    expect(calls[0].max_output_tokens).toBe(4096)
    expect(calls[0].input).toBe("Oats 150 kcal")
    expect(calls[0].store).toBe(false)
    expect(result.reply.foods).toEqual([{ name: "Oats", calories: 150 }])
  })
})
```

Append to `src/ai/service.test.ts`:

```ts
describe("parseFoods", () => {
  const PARSED = { foods: [{ name: "Oats", calories: 150 }], unreadable: [] }

  function foodsProvider(result: Error | { reply: typeof PARSED; usage: ProviderResult["usage"] }): AIProvider {
    return {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => {
        throw new Error("not used")
      },
      parseFoods: async () => {
        if (result instanceof Error) throw result
        return result
      },
    }
  }

  test("returns the reply and records an import call", async () => {
    service = build(foodsProvider({ reply: PARSED, usage: OK_RESULT.usage }))
    const reply = await service.parseFoods("Oats 150 kcal", "openai", { telegramId: 42, chatId: 7 })

    expect(reply).toEqual(PARSED)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ callType: "import", status: "ok", telegramId: 42 })
    expect(analytics.events.find((e) => e.event === "$ai_generation")?.properties).toMatchObject({ $ai_span_name: "import" })
  })

  test("a failure is reported and rethrown", async () => {
    service = build(foodsProvider(new Error("down")))
    await expect(service.parseFoods("x", "openai", { telegramId: 42, chatId: 7 })).rejects.toThrow("down")
    expect(analytics.exceptions[0].properties).toMatchObject({ source: "ai", call_type: "import" })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/ai`
Expected: FAIL. `FOODS_PARSE_PROMPT`, `normalizeFoodsReply` and `parseFoods` don't exist yet.

- [ ] **Step 3: Implement**

`src/ai/types.ts`: add `"import"` to `CallType`:

```ts
export type CallType = "estimate" | "clarify" | "edit" | "retry" | "backfill" | "import"
```

Add to `AIProvider`:

```ts
  /** A pasted table or typed food → rows, one call. Rows are untrusted; src/library/validate.ts checks them. */
  parseFoods(text: string): Promise<FoodsParseResult>
```

and append:

```ts
export interface ParsedFoodsReply {
  /** Rows as the model gave them: untrusted, validated by src/library/validate.ts. */
  foods: Record<string, unknown>[]
  unreadable: { text: string; reason: string }[]
}

export interface FoodsParseResult {
  reply: ParsedFoodsReply
  usage: TokenUsage
  trace?: AITrace
}
```

`src/ai/prompt.ts`, appended (the field list is prose: a new macro updates it by hand, and `prompt.test.ts` fails until it does):

```ts
/** Output limit for parseFoods: a 60-row paste overflows the estimate call's 1024. */
export const FOODS_MAX_TOKENS = 4096

export const FOODS_PARSE_PROMPT = `You turn pasted nutrition information into structured rows. The text may be a table copied from a document or spreadsheet, a list, or one food typed by hand.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"foods":[{"name":"Quaker Oats","serving":"1/2 cup (40 g)","serving_amount":40,"serving_unit":"g","calories":150,"protein_g":5,"fat_g":3,"fiber_g":4,"added_sugar_g":null}],"unreadable":[{"text":"lunch adobo","reason":"no calories"}]}

Rules:
- One entry in foods per food. All values are per serving.
- If a row gives both per serving and per 100 g values, use per serving. If it gives only per 100 g values, set serving to "100 g", serving_amount to 100 and serving_unit to "g".
- serving: the serving size as written, e.g. "1 cup (250 ml)". Empty string if none is given.
- serving_amount and serving_unit: the serving's weight in grams ("g") or volume in millilitres ("ml") when it is written; otherwise null.
- calories: kcal per serving. Convert kJ by dividing by 4.184.
- protein_g, fat_g, fiber_g, added_sugar_g: grams per serving as written, decimals allowed; null when not given.
- added_sugar_g only from an "added sugar" value; total sugars do not count, so leave it null when only total sugars are given.
- Never estimate a value that is not in the text.
- A row with no calories goes in unreadable with reason "no calories". Text that is not a food (headings, notes, blank lines) is ignored.`
```

`src/ai/parse.ts` (add `type ParsedFoodsReply` to the `./types` import):

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A parse-foods reply in a safe shape: rows stay raw for validateFood; unreadable entries become strings. */
export function normalizeFoodsReply(reply: unknown): ParsedFoodsReply {
  const r = isRecord(reply) ? reply : {}
  const foods = Array.isArray(r.foods) ? r.foods.filter(isRecord) : []
  const unreadable = Array.isArray(r.unreadable)
    ? r.unreadable
        .filter(isRecord)
        .map((u) => ({
          text: String(u.text ?? "").trim(),
          reason: String(u.reason ?? "").trim() || "unreadable",
        }))
        .filter((u) => u.text)
    : []
  return { foods, unreadable }
}
```

`src/ai/providers/anthropic.ts` (import `FOODS_PARSE_PROMPT, FOODS_MAX_TOKENS` from `../prompt`, `normalizeFoodsReply` from `../parse`, `FoodsParseResult` from `../types`):

```ts
  async parseFoods(text: string): Promise<FoodsParseResult> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: FOODS_MAX_TOKENS,
      system: FOODS_PARSE_PROMPT,
      messages: [{ role: "user", content: text }],
    })

    const output = firstText(response)
    const usage = usageFrom(response)
    const trace = traceOf(FOODS_PARSE_PROMPT, text, output)
    return { reply: normalizeFoodsReply(parseReply(stripFences(output), usage, trace)), usage, trace }
  }
```

`src/ai/providers/gemini.ts` (same imports, without `FOODS_MAX_TOKENS`):

```ts
  // Gemini's default output limit is already far above a pasted table's needs.
  async parseFoods(text: string): Promise<FoodsParseResult> {
    const { text: output, usage } = await this.generate(FOODS_PARSE_PROMPT, text)
    const trace = traceOf(FOODS_PARSE_PROMPT, text, output)
    return { reply: normalizeFoodsReply(parseReply(stripFences(output), usage, trace)), usage, trace }
  }
```

`src/ai/providers/openai.ts` (import `FOODS_PARSE_PROMPT, FOODS_MAX_TOKENS` from `../prompt`, `normalizeFoodsReply` from `../parse`, `FoodsParseResult` from `../types`). Add the schema after `MACRO_BATCH_SCHEMA`:

```ts
const NULLABLE_NUMBER = { type: ["number", "null"] }

/** Strict: every field required; nullable where a label may leave it out. serving_unit is checked by validateFood. */
const FOODS_SCHEMA = {
  type: "object",
  properties: {
    foods: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          serving: { type: "string" },
          serving_amount: NULLABLE_NUMBER,
          serving_unit: { type: ["string", "null"] },
          calories: { type: "number" },
          ...Object.fromEntries(MACROS.map((m) => [m.column, NULLABLE_NUMBER])),
        },
        required: ["name", "serving", "serving_amount", "serving_unit", "calories", ...MACRO_COLUMNS],
        additionalProperties: false,
      },
    },
    unreadable: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, reason: { type: "string" } },
        required: ["text", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["foods", "unreadable"],
  additionalProperties: false,
}
```

and the method:

```ts
  async parseFoods(text: string): Promise<FoodsParseResult> {
    const response = await this.client.responses.create({
      model: MODEL,
      instructions: FOODS_PARSE_PROMPT,
      input: text,
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: FOODS_MAX_TOKENS,
      text: {
        format: { type: "json_schema", name: "foods", schema: FOODS_SCHEMA, strict: true },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    const usage = usageFrom(response)
    const trace = traceOf(FOODS_PARSE_PROMPT, text, content)
    return { reply: normalizeFoodsReply(parseReply(content, usage, trace)), usage, trace }
  }
```

`src/ai/service.ts`: import `type ParsedFoodsReply` from `./types` and add after `estimateMacros`:

```ts
  /** A pasted table or typed food → rows, one billed call (call type "import"). No cache. */
  async parseFoods(text: string, providerName: string, opts: BatchOptions): Promise<ParsedFoodsReply> {
    const provider = this.resolveProvider(providerName)
    const recordOpts: EstimateOptions = { ...opts, callType: "import" }

    let result
    const started = performance.now()
    try {
      result = await provider.parseFoods(text)
    } catch (error) {
      this.recordFailure(error, provider.name, recordOpts, performance.now() - started)
      throw error
    }

    this.recordSafely(provider.name, result.usage, recordOpts, this.statusFor(result.usage), {
      trace: result.trace,
      latencyMs: performance.now() - started,
    })
    return result.reply
  }
```

`scripts/smoke-providers.ts`: update the usage comment and mode parsing:

```ts
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --foods   # parseFoods()
```

```ts
const flag = process.argv[3]
const mode = flag === "--macros" ? "macros" : flag === "--foods" ? "foods" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--macros|--foods]")
  process.exit(1)
}
```

and before the `if (mode === "macros")` block inside the `try`:

```ts
  if (mode === "foods") {
    const pasted =
      "Quaker Oats, 1/2 cup (40 g): 150 kcal, protein 5 g, fat 3 g, fiber 4 g\n" +
      "Nestle Fresh Milk per 1 cup (250 ml): 160 kcal, 8 g protein, 9 g fat, sugars 12 g\n" +
      "lunch adobo"
    const reply = await service.parseFoods(pasted, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to parseFoods`)
    console.log(JSON.stringify(reply, null, 2))
    console.log("  Check by eye: milk's added_sugar_g should be null (12 g is total sugars).")
    if (reply.foods.length !== 2) {
      console.error(`✗ Expected 2 foods, got ${reply.foods.length}.`)
      await finish(1)
    }
    await finish(0)
  }
```

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai scripts/smoke-providers.ts
git commit -m "$(cat <<'EOF'
feat(ai): parseFoods turns a pasted table into rows, call type import (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `MealEstimator`

**Files:**
- Create: `src/library/estimator.ts`, `src/library/estimator.test.ts`

**Interfaces:**
- Consumes:
  - `matchMeal`, `candidatesFor`, `scaleFood`, `MatchedItem` (Task 3)
  - `AIService.estimate`, `EstimateOptions` with `savedFoods`, and `EstimationResult.cached` (Task 4)
  - `FoodLibraryRepository.listByUser` (Task 2)
- Produces:
  - `type EstimateSource = "library" | "mixed" | "ai" | "cache"`
  - `type MealEstimate = EstimationResult & { source: EstimateSource }`
  - `interface MealEstimatorDeps { enabled: boolean; library: Pick<FoodLibraryRepository, "listByUser">; ai: Pick<AIService, "estimate">; analytics?: Analytics }`
  - `class MealEstimator(deps)` with `estimate(text: string, provider: string, opts: EstimateOptions): Promise<MealEstimate>`
  - `applyLabels(items: FoodEstimate[], candidates: SavedFood[]): FoodEstimate[]`
  - PostHog event `meal_estimated` with `{ source, saved_foods_used: number, clarification: boolean }`

- [ ] **Step 1: Write the failing tests**

`src/library/estimator.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test"
import { MealEstimator } from "./estimator"
import { FakeAnalytics } from "../analytics/test-helpers"
import type { AIService } from "../ai/service"
import type { EstimationResult } from "../ai/types"
import type { SavedFood } from "./types"

const OATS: SavedFood = {
  id: 1,
  telegram_id: 42,
  source: "import",
  name: "Quaker Oats",
  serving: "1/2 cup (40 g)",
  serving_amount: 40,
  serving_unit: "g",
  calories: 150,
  protein_g: 5,
  fat_g: 3,
  fiber_g: 4,
  added_sugar_g: null,
}

const BANANA = { description: "Banana", calories: 105, protein_g: 1, fat_g: 0, fiber_g: 3, added_sugar_g: 0, emoji: "🍌" }
const BANANA_REPLY: EstimationResult = { items: [BANANA], needsClarification: false, confidence: "high" }
const OPTS = { telegramId: 42, chatId: 7, callType: "estimate" as const }

function build(opts: { enabled?: boolean; foods?: SavedFood[]; reply?: EstimationResult; listThrows?: boolean } = {}) {
  const analytics = new FakeAnalytics()
  const ai = { estimate: mock(async () => opts.reply ?? BANANA_REPLY) }
  const library = {
    listByUser: mock(() => {
      if (opts.listThrows) throw new Error("db gone")
      return opts.foods ?? [OATS]
    }),
  }
  const estimator = new MealEstimator({
    enabled: opts.enabled ?? true,
    library,
    ai: ai as unknown as Pick<AIService, "estimate">,
    analytics,
  })
  return { estimator, ai, library, analytics }
}

describe("MealEstimator", () => {
  test("flag off: a plain AI call, the library untouched", async () => {
    const { estimator, ai, library } = build({ enabled: false })
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
    expect(library.listByUser).not.toHaveBeenCalled()
    expect(result.source).toBe("ai")
    expect(result.items).toEqual([BANANA])
  })

  test("an empty library: a plain AI call", async () => {
    const { estimator, ai } = build({ foods: [] })
    await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
  })

  test("a fully matched meal makes no AI call", async () => {
    const { estimator, ai, analytics } = build()
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ source: "library", needsClarification: false })
    expect(result.items).toEqual([
      { description: "Quaker Oats ×2", calories: 300, protein_g: 10, fat_g: 6, fiber_g: 8, added_sugar_g: null, saved_food_id: 1 },
    ])
    expect(analytics.events).toEqual([
      { telegramId: 42, event: "meal_estimated", properties: { source: "library", saved_foods_used: 1, clarification: false } },
    ])
  })

  test("a mixed meal: candidates go to the AI, label values replace its numbers, blanks keep the AI's", async () => {
    const reply: EstimationResult = {
      items: [
        { description: "Oatmeal", calories: 200, protein_g: 7, fat_g: 4, fiber_g: 5, added_sugar_g: 2, emoji: "🥣", saved_food_id: 1, servings: 2 },
        { ...BANANA, saved_food_id: null, servings: null },
      ],
      needsClarification: false,
      confidence: "medium",
    }
    const { estimator, ai } = build({ reply })
    const result = await estimator.estimate("80g oats and a banana", "openai", OPTS)

    expect(ai.estimate).toHaveBeenCalledWith("80g oats and a banana", "openai", { ...OPTS, savedFoods: [OATS] })
    expect(result.source).toBe("mixed")
    expect(result.items[0]).toEqual({
      description: "Quaker Oats ×2",
      calories: 300,
      protein_g: 10,
      fat_g: 6,
      fiber_g: 8,
      added_sugar_g: 2,
      emoji: "🥣",
      saved_food_id: 1,
    })
    expect(result.items[1]).toEqual({ ...BANANA, saved_food_id: null })
  })

  test("an id that was not a candidate, or servings that aren't positive, keep the AI's numbers", async () => {
    const reply: EstimationResult = {
      items: [
        { description: "Oatmeal", calories: 200, protein_g: 7, fat_g: 4, fiber_g: 5, added_sugar_g: 2, saved_food_id: 99, servings: 2 },
        { description: "Oats", calories: 180, protein_g: 6, fat_g: 3, fiber_g: 4, added_sugar_g: 0, saved_food_id: 1, servings: 0 },
      ],
      needsClarification: false,
      confidence: "medium",
    }
    const { estimator } = build({ reply })
    const result = await estimator.estimate("oats and oatmeal bowl", "openai", OPTS)
    expect(result.source).toBe("ai")
    expect(result.items.map((i) => [i.calories, i.saved_food_id])).toEqual([[200, null], [180, null]])
    expect(result.items.every((i) => !("servings" in i))).toBe(true)
  })

  test("a clarification reply never takes the code-only path", async () => {
    const { estimator, ai } = build()
    await estimator.estimate("2 oats", "openai", { ...OPTS, callType: "clarify", context: 'Original input: "oats"' })
    expect(ai.estimate).toHaveBeenCalledWith(
      "2 oats",
      "openai",
      expect.objectContaining({ context: 'Original input: "oats"', savedFoods: [OATS] })
    )
  })

  test("no relevant saved food: a plain AI call; a cache hit reports source cache", async () => {
    const { estimator, ai } = build({ reply: { ...BANANA_REPLY, cached: true } })
    const result = await estimator.estimate("banana", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("banana", "openai", OPTS)
    expect(result.source).toBe("cache")
  })

  test("a library error is reported and the estimate falls back to a plain AI call", async () => {
    const { estimator, ai, analytics } = build({ listThrows: true })
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(analytics.exceptions[0]).toMatchObject({ telegramId: 42, properties: { source: "library" } })
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
    expect(result.source).toBe("ai")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/library/estimator.test.ts`
Expected: FAIL with "Cannot find module './estimator'".

- [ ] **Step 3: Implement**

`src/library/estimator.ts`:

```ts
// src/library/estimator.ts
// Every meal estimate goes through here (LogFlow and the retry job). With the
// food library on, a meal made only of saved foods is built in code with no AI
// call; otherwise the AI sees the relevant saved foods and code applies their
// label values. The library can never break logging: any library error falls
// back to a plain AI estimate.
import type { AIService, EstimateOptions } from "../ai/service"
import type { EstimationResult, FoodEstimate } from "../ai/types"
import type { FoodLibraryRepository } from "../db/repositories/food-library"
import { noopAnalytics, type Analytics } from "../analytics"
import { MACROS } from "../macros"
import { candidatesFor, matchMeal, scaleFood, type MatchedItem } from "./match"
import type { SavedFood } from "./types"

export type EstimateSource = "library" | "mixed" | "ai" | "cache"
export type MealEstimate = EstimationResult & { source: EstimateSource }

export interface MealEstimatorDeps {
  /** FEATURE_LOCAL_FOOD_DB. Off: every estimate is a plain AIService call, as before. */
  enabled: boolean
  library: Pick<FoodLibraryRepository, "listByUser">
  ai: Pick<AIService, "estimate">
  /** The Analytics createBot returns, so the meal-text opt-out applies. */
  analytics?: Analytics
}

type Found = { matched: MatchedItem[] | null; candidates: SavedFood[] }
const NOTHING_FOUND: Found = { matched: null, candidates: [] }

function libraryResult(matched: MatchedItem[]): EstimationResult {
  return {
    items: matched.map((m) => scaleFood(m.food, m.servings)),
    needsClarification: false,
    confidence: "high",
  }
}

/**
 * Label values over the AI's numbers, for each item the AI tied to one of the
 * candidates; the AI's value stays where the label is blank. Anything else (no
 * id, an id we didn't send, servings that aren't positive) keeps the AI's
 * numbers. `servings` never leaves here.
 */
export function applyLabels(items: FoodEstimate[], candidates: SavedFood[]): FoodEstimate[] {
  const byId = new Map(candidates.map((f) => [f.id, f]))
  return items.map(({ servings, ...item }) => {
    const food = item.saved_food_id ? byId.get(item.saved_food_id) : undefined
    if (!food || typeof servings !== "number" || !(servings > 0)) return { ...item, saved_food_id: null }
    const scaled = scaleFood(food, servings)
    const out: FoodEstimate = { ...item, description: scaled.description, calories: scaled.calories, saved_food_id: food.id }
    for (const m of MACROS) out[m.column] = scaled[m.column] ?? item[m.column]
    return out
  })
}

export class MealEstimator {
  private analytics: Analytics

  constructor(private deps: MealEstimatorDeps) {
    this.analytics = deps.analytics ?? noopAnalytics
  }

  async estimate(text: string, provider: string, opts: EstimateOptions): Promise<MealEstimate> {
    const found = this.deps.enabled ? this.consultLibrary(text, opts) : NOTHING_FOUND
    if (found.matched) return this.finish(opts.telegramId, libraryResult(found.matched), "library")

    if (found.candidates.length === 0) {
      const result = await this.deps.ai.estimate(text, provider, opts)
      return this.finish(opts.telegramId, result, result.cached ? "cache" : "ai")
    }

    const result = await this.deps.ai.estimate(text, provider, { ...opts, savedFoods: found.candidates })
    const items = applyLabels(result.items, found.candidates)
    return this.finish(opts.telegramId, { ...result, items }, items.some((i) => i.saved_food_id) ? "mixed" : "ai")
  }

  /** Saved foods for this message. A clarification reply never takes the code-only path. */
  private consultLibrary(text: string, opts: EstimateOptions): Found {
    try {
      const foods = this.deps.library.listByUser(opts.telegramId)
      if (foods.length === 0) return NOTHING_FOUND
      const matched = opts.context ? null : matchMeal(text, foods)
      if (matched) return { matched, candidates: [] }
      // With context, the original message and earlier replies count too.
      return { matched: null, candidates: candidatesFor(`${text} ${opts.context ?? ""}`, foods) }
    } catch (error) {
      this.analytics.captureException(error, opts.telegramId, { source: "library" })
      return NOTHING_FOUND
    }
  }

  private finish(telegramId: number, result: EstimationResult, source: EstimateSource): MealEstimate {
    this.analytics.capture(telegramId, "meal_estimated", {
      source,
      saved_foods_used: result.items.filter((i) => i.saved_food_id).length,
      clarification: result.needsClarification,
    })
    return { ...result, source }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/library`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/estimator.ts src/library/estimator.test.ts
git commit -m "$(cat <<'EOF'
feat(library): MealEstimator, code-only matches skip the AI (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `LogFlow` and the retry job use `MealEstimator`

**Files:**
- Modify: `src/bot/conversations/log-flow.ts`, `src/bot/conversations/log-flow.test.ts`
- Modify: `src/jobs/retry-pending.ts`, `src/jobs/retry-pending.test.ts`
- Modify: `src/bot/index.ts`, `src/index.ts`

**Interfaces:**
- Consumes:
  - `MealEstimator` (Task 6)
  - `FoodLibraryRepository` (Task 2)
  - `FoodItem.saved_food_id` (Task 2)
- Produces:
  - `new LogFlow(conversations, foodLogs, pending, estimator: Pick<MealEstimator, "estimate">, users, opts: { foodLibrary?: boolean } = {})`
  - `LogFlowResult.saveOffer?: { logId: number }`
  - `ConfirmationOutcome` (when not stale) gains `saveOffer?: { logId: number }`. Both are set only when `opts.foodLibrary` is true.
  - Confirmation messages end with `\n\nFrom your foods: <descriptions>` when any item has `saved_food_id`
  - `createRetryPendingJob(bot, pendingRepo, foodLogsRepo, usersRepo, estimator: Pick<MealEstimator, "estimate">, analytics?)`, and the same for `startRetryPendingJob`
  - `createBot()` also returns `foodLibraryRepo` and `mealEstimator`

- [ ] **Step 1: Write the failing tests**

In `src/bot/conversations/log-flow.test.ts`: change the import `import { AIService } from "../../ai/service"` to `import type { MealEstimator } from "../../library/estimator"`, and change the cast in `beforeEach` from `mockAIService as unknown as AIService` to `mockAIService as unknown as MealEstimator`. Then append inside the top-level `describe("LogFlow", ...)`:

```ts
  test("the confirmation names the items that came from saved foods", async () => {
    mockAIService.estimate.mockImplementation(() =>
      Promise.resolve({
        items: [
          { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 1 },
          { description: "Banana", calories: 105, protein_g: 1, emoji: "🍌" },
        ],
        needsClarification: false,
        confidence: "high" as const,
        source: "mixed" as const,
      })
    )
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "80g oats and a banana", "openai")
    expect(result.message).toEndWith("\n\nFrom your foods: Quaker Oats ×2")
  })

  test("no footer when nothing came from saved foods", async () => {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")
    expect(result.message).not.toContain("From your foods")
  })

  test("with the food library on, logging offers Save to my foods with the new log's id", async () => {
    const withLibrary = new LogFlow(
      conversationsRepo,
      foodLogsRepo,
      pendingRepo,
      mockAIService as unknown as MealEstimator,
      usersRepo,
      { foodLibrary: true }
    )
    const items = JSON.stringify([{ description: "Chicken", calories: 200, protein_g: 25, emoji: "🍗" }])

    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", { pending_items: items })
    const typed = await withLibrary.processInput(123, 456, "yes", "openai")
    const firstLog = foodLogsRepo.getByDate(123, "2026-01-31")[0]
    expect(typed.saveOffer).toEqual({ logId: firstLog.id })

    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", { pending_items: items })
    const pressed = withLibrary.resolveConfirmation(123, 456, confirmToken("2026-01-31", items), "log")
    const newest = Math.max(...foodLogsRepo.getByDate(123, "2026-01-31").map((log) => log.id))
    expect(pressed).toMatchObject({ stale: false, saveOffer: { logId: newest } })
  })

  test("with the food library off, there is no save offer", async () => {
    const items = JSON.stringify([{ description: "Chicken", calories: 200, emoji: "🍗" }])
    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", { pending_items: items })
    const typed = await logFlow.processInput(123, 456, "yes", "openai")
    expect(typed.saveOffer).toBeUndefined()
  })
```

In `src/jobs/retry-pending.test.ts`, change `import type { AIService } ...` (or the value import) to `import type { MealEstimator } from "../library/estimator"`, and change every `{ estimate } as unknown as AIService` to `{ estimate } as unknown as MealEstimator`. The tests' behaviour doesn't change.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/bot/conversations src/jobs`
Expected: FAIL. There is no footer, `LogFlow` ignores a 6th argument, and `saveOffer` is undefined.

- [ ] **Step 3: Implement**

`src/bot/conversations/log-flow.ts`:

1. Imports: remove `import { AIService } from "../../ai/service"` and `import { EstimationResult } from "../../ai/types"`; add:

```ts
import type { MealEstimator, MealEstimate } from "../../library/estimator"
import { escapeHtml, formatItemsSummary, formatTotals, sumTotals, shortHash } from "../../utils/format"
```

(replacing the existing `../../utils/format` import).

2. Types:

```ts
export interface LogFlowResult {
  message: string
  action: "prompt" | "done" | "ask_continue" | "continue" | "error"
  parseMode?: "HTML"
  /** Set on a confirmation message; the bot layer turns it into the Log/Change/Cancel keyboard. */
  confirm?: { token: string; totals: Totals; macros: MacroKey[] }
  /** Set after logging when the food library is on; the bot layer adds "Save to my foods". */
  saveOffer?: { logId: number }
}

export type ConfirmationOutcome =
  | { stale: true }
  | { stale: false; edit: string; toast?: string; followUp?: string; saveOffer?: { logId: number } }
```

3. Constructor:

```ts
  constructor(
    private conversations: ConversationsRepository,
    private foodLogs: FoodLogsRepository,
    private pending: PendingRepository,
    private estimator: Pick<MealEstimator, "estimate">,
    private users: Pick<UsersRepository, "findById">,
    /** foodLibrary: FEATURE_LOCAL_FOOD_DB, which turns on the save offer after logging. */
    private opts: { foodLibrary?: boolean } = {}
  ) {}
```

4. In `handleAwaitingInput` and `handleClarifying`, replace `this.aiService.estimate(` with `this.estimator.estimate(`. In `processEstimationResult`, change the `result` parameter type from `EstimationResult` to `MealEstimate`.

5. `commitPending` returns the log id, and a helper builds the offer:

```ts
  private commitPending(
    telegramId: number,
    chatId: number,
    targetDate: string,
    items: FoodItem[]
  ): number {
    const log = this.foodLogs.create(telegramId, chatId, targetDate, items)
    this.conversations.delete(telegramId)
    return log.id
  }

  /** The "Save to my foods" offer for a just-logged entry, when the library is on. */
  private saveOffer(logId: number): { saveOffer?: { logId: number } } {
    return this.opts.foodLibrary ? { saveOffer: { logId } } : {}
  }
```

6. In `handleConfirming`'s yes branch:

```ts
      const logId = this.commitPending(telegramId, chatId, state.target_date, items)

      return {
        message: `Logged ${formatTotals(sumTotals(items), this.macrosFor(telegramId))} for ${formatDateForDisplay(state.target_date)}.`,
        action: "done",
        ...this.saveOffer(logId),
      }
```

7. In `resolveConfirmation`'s `"log"` case:

```ts
      case "log": {
        const logId = this.commitPending(telegramId, chatId, state.target_date, items)
        return {
          stale: false,
          edit: `✅ Logged to ${formatDateForDisplay(state.target_date)}:\n\n${formatItemsSummary(items, macros)}`,
          toast: "Logged ✅",
          ...this.saveOffer(logId),
        }
      }
```

8. In `confirmationResult`, add the footer:

```ts
    const macros = this.macrosFor(telegramId)
    const fromLibrary = items.filter((item) => item.saved_food_id).map((item) => item.description)
    const footer = fromLibrary.length > 0 ? `\n\nFrom your foods: ${escapeHtml(fromLibrary.join(", "))}` : ""
    return {
      message: `${header}\n\n${formatItemsSummary(items, macros)}${footer}`,
```

(the rest of the returned object is unchanged).

`src/jobs/retry-pending.ts`: replace `import { AIService } from "../ai/service"` with `import type { MealEstimator } from "../library/estimator"`. In both `createRetryPendingJob` and `startRetryPendingJob`, change the parameter `aiService: AIService` to `estimator: Pick<MealEstimator, "estimate">`. Change the call to `const result = await estimator.estimate(entry.food_text, provider, {` and pass `estimator` through in `startRetryPendingJob`.

`src/bot/index.ts`: add imports:

```ts
import { FoodLibraryRepository } from "../db/repositories/food-library"
import { MealEstimator } from "../library/estimator"
```

and replace the `logFlow` line with:

```ts
  const foodLibraryRepo = new FoodLibraryRepository(db)
  const foodLibraryEnabled = config.features.localFoodDb
  const mealEstimator = new MealEstimator({ enabled: foodLibraryEnabled, library: foodLibraryRepo, ai: aiService, analytics })
  const logFlow = new LogFlow(conversationsRepo, foodLogsRepo, pendingRepo, mealEstimator, usersRepo, {
    foodLibrary: foodLibraryEnabled,
  })
```

and add `foodLibraryRepo, mealEstimator` to the returned object.

`src/index.ts`: destructure `mealEstimator` instead of `aiService` from `createBot(analytics)`, and pass `mealEstimator` to `startRetryPendingJob` in place of `aiService`.

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS. The existing exact `resolveConfirmation` `toEqual` test still passes, because the default `LogFlow` has the library off.

- [ ] **Step 5: Commit**

```bash
git add src/bot/conversations src/jobs/retry-pending.ts src/jobs/retry-pending.test.ts src/bot/index.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(log): logging and retries estimate through MealEstimator; From your foods footer (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Previews

**Files:**
- Create: `src/library/preview.ts`, `src/library/preview.test.ts`

**Interfaces:**
- Consumes:
  - `validateFood`, `AS_LOGGED`, `DEFAULT_SERVING` (Task 1)
  - `ParsedFoodsReply` (Task 5)
  - `FoodItem` (Task 2)
  - `normalizeFoodName` (Task 1)
- Produces:
  - `type PreviewRow = { food: FoodFields; replaces: boolean }`
  - `type Unreadable = { text: string; reason: string }`
  - `type Preview = { rows: PreviewRow[]; unreadable: Unreadable[] }`
  - `importPreview(reply: ParsedFoodsReply, existing: SavedFood[]): Preview`
  - `logPreview(items: FoodItem[], existing: SavedFood[]): Preview`
  - `formatFoodLine(food: FoodFields): string`
  - `formatPreview(header: string, preview: Preview): string` (at most 4096 characters)

- [ ] **Step 1: Write the failing tests**

`src/library/preview.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { formatFoodLine, formatPreview, importPreview, logPreview } from "./preview"
import type { FoodFields, SavedFood } from "./types"

const OATS_ROW = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
const SKY_ROW = { name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 3.5, fiber_g: null, added_sugar_g: 1 }

const SAVED_SKY: SavedFood = {
  ...(SKY_ROW as FoodFields),
  id: 3,
  telegram_id: 42,
  source: "import",
}

describe("importPreview", () => {
  test("keeps valid rows, marks replacements, and lists the rest as unreadable", () => {
    const preview = importPreview(
      {
        foods: [OATS_ROW, { ...SKY_ROW, name: "skyflakes" }, { name: "Lunch adobo", serving: "" }],
        unreadable: [{ text: "notes", reason: "not a food" }],
      },
      [SAVED_SKY]
    )
    expect(preview.rows.map((r) => [r.food.name, r.replaces])).toEqual([
      ["Quaker Oats", false],
      ["skyflakes", true],
    ])
    expect(preview.unreadable).toEqual([
      { text: "notes", reason: "not a food" },
      { text: "Lunch adobo", reason: "no calories" },
    ])
  })

  test("the same name twice: the later row wins", () => {
    const preview = importPreview({ foods: [SKY_ROW, { ...SKY_ROW, calories: 120 }], unreadable: [] }, [])
    expect(preview.rows.map((r) => r.food.calories)).toEqual([120])
  })
})

describe("logPreview", () => {
  test("turns logged items into foods served as logged, leaving out items from saved foods", () => {
    const preview = logPreview(
      [
        { description: "Chicken adobo (1 cup)", calories: 350, protein_g: 30, fat_g: 20, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" },
        { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 1 },
      ],
      []
    )
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].food).toMatchObject({ name: "Chicken adobo (1 cup)", serving: "as logged", serving_amount: null, calories: 350 })
  })
})

describe("formatFoodLine / formatPreview", () => {
  test("a line shows every value the label has", () => {
    expect(formatFoodLine(OATS_ROW as FoodFields)).toBe("Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber")
    expect(formatFoodLine({ ...(SKY_ROW as FoodFields), serving: "1 serving" })).toBe(
      "Skyflakes · no serving size · 110 cal · 2g protein · 3.5g fat · 1g added sugar"
    )
  })

  test("header, numbered rows, replacements and unreadable rows", () => {
    const preview = importPreview(
      { foods: [OATS_ROW, SKY_ROW], unreadable: [{ text: "lunch adobo", reason: "no calories" }] },
      [SAVED_SKY]
    )
    expect(formatPreview("Found 2 foods (per serving):", preview)).toBe(
      "Found 2 foods (per serving):\n" +
        "1. Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber\n" +
        "2. Skyflakes · 1 pack (25 g) · 110 cal · 2g protein · 3.5g fat · 1g added sugar (replaces your saved one)\n" +
        'Couldn\'t read: "lunch adobo" (no calories)'
    )
  })

  test("a long preview fits one Telegram message and says how many rows it left out", () => {
    const foods = Array.from({ length: 120 }, (_, i) => ({ ...OATS_ROW, name: `Very long food name number ${i} with extra words` }))
    const text = formatPreview("Found 120 foods (per serving):", importPreview({ foods, unreadable: [] }, []))
    expect(text.length).toBeLessThanOrEqual(4096)
    const shown = text.split("\n").filter((line) => /^\d+\. /.test(line)).length
    expect(text).toEndWith(`…and ${120 - shown} more`)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/library/preview.test.ts`
Expected: FAIL with "Cannot find module './preview'".

- [ ] **Step 3: Implement**

`src/library/preview.ts`:

```ts
// src/library/preview.ts
// What a user sees before anything is saved: rows from a paste or a log,
// validated, marked when they replace a saved food, and formatted to fit one
// Telegram message.
import { MACROS } from "../macros"
import type { ParsedFoodsReply } from "../ai/types"
import type { FoodItem } from "../db/repositories/food-logs"
import { normalizeFoodName } from "../utils/normalize"
import { AS_LOGGED, DEFAULT_SERVING, validateFood } from "./validate"
import type { FoodFields, SavedFood } from "./types"

export type PreviewRow = { food: FoodFields; replaces: boolean }
export type Unreadable = { text: string; reason: string }
export type Preview = { rows: PreviewRow[]; unreadable: Unreadable[] }

/** Telegram's limit is 4096; leave room for the header and the "…and N more" line. */
const MAX_PREVIEW_CHARS = 3800
const MAX_UNREADABLE_SHOWN = 5
const MAX_UNREADABLE_TEXT = 40

function finish(foods: FoodFields[], unreadable: Unreadable[], existing: SavedFood[]): Preview {
  // The same name twice in one batch: the later row wins, as saving would.
  const byName = new Map<string, FoodFields>()
  for (const food of foods) {
    const key = normalizeFoodName(food.name)
    byName.delete(key)
    byName.set(key, food)
  }
  const saved = new Set(existing.map((f) => normalizeFoodName(f.name)))
  return {
    rows: [...byName.entries()].map(([key, food]) => ({ food, replaces: saved.has(key) })),
    unreadable,
  }
}

/** A parse reply → rows that passed validateFood; the rest join the model's own unreadable list. */
export function importPreview(reply: ParsedFoodsReply, existing: SavedFood[]): Preview {
  const foods: FoodFields[] = []
  const unreadable: Unreadable[] = [...reply.unreadable]
  for (const raw of reply.foods) {
    const result = validateFood(raw)
    if (result.ok) foods.push(result.food)
    else unreadable.push({ text: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "a row", reason: result.reason })
  }
  return finish(foods, unreadable, existing)
}

/** A log's items → foods served "as logged". Items that came from saved foods are left out. */
export function logPreview(items: FoodItem[], existing: SavedFood[]): Preview {
  const foods: FoodFields[] = []
  const unreadable: Unreadable[] = []
  for (const item of items) {
    if (item.saved_food_id) continue
    const result = validateFood({ ...item, name: item.description, serving: AS_LOGGED })
    if (result.ok) foods.push(result.food)
    else unreadable.push({ text: item.description, reason: result.reason })
  }
  return finish(foods, unreadable, existing)
}

/** "Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber": every value the label has. */
export function formatFoodLine(food: FoodFields): string {
  const serving = food.serving === DEFAULT_SERVING ? "no serving size" : food.serving
  const macros = MACROS.filter((m) => food[m.column] !== null).map((m) => `${food[m.column]}g ${m.totalLabel}`)
  return [food.name, serving, `${food.calories} cal`, ...macros].join(" · ")
}

function unreadableLine(unreadable: Unreadable[]): string {
  if (unreadable.length === 0) return ""
  const shown = unreadable.slice(0, MAX_UNREADABLE_SHOWN).map((u) => {
    const text = u.text.length > MAX_UNREADABLE_TEXT ? `${u.text.slice(0, MAX_UNREADABLE_TEXT - 1)}…` : u.text
    return `"${text}" (${u.reason})`
  })
  const more = unreadable.length > MAX_UNREADABLE_SHOWN ? `, and ${unreadable.length - MAX_UNREADABLE_SHOWN} more` : ""
  return `\nCouldn't read: ${shown.join(", ")}${more}`
}

/** Header, numbered rows, then what couldn't be read. Rows are cut to fit one message, ending "…and N more". */
export function formatPreview(header: string, preview: Preview): string {
  const footer = unreadableLine(preview.unreadable)
  const lines: string[] = []
  let length = header.length + footer.length
  for (const [i, row] of preview.rows.entries()) {
    const line = `${i + 1}. ${formatFoodLine(row.food)}${row.replaces ? " (replaces your saved one)" : ""}`
    if (length + line.length + 1 > MAX_PREVIEW_CHARS) {
      lines.push(`…and ${preview.rows.length - i} more`)
      break
    }
    lines.push(line)
    length += line.length + 1
  }
  return [header, ...lines].join("\n") + footer
}
```

Note on the truncation test: the "…and N more" line comes before the footer, and that test has no unreadable rows, so the text ends with it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/library`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/library/preview.ts src/library/preview.test.ts
git commit -m "$(cat <<'EOF'
feat(library): previews for pasted and logged foods (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `/foods`: hub, add, paste, preview and Save

**Files:**
- Modify: `src/bot/utils/callback-data.ts`, `src/bot/utils/callback-data.test.ts`
- Create: `src/bot/commands/foods.ts`, `src/bot/commands/foods.test.ts`
- Modify: `src/bot/index.ts`

**Interfaces:**
- Consumes:
  - `FoodLibraryRepository` (Task 2)
  - `AIService.parseFoods` (Task 5)
  - `importPreview`, `formatPreview`, `Preview` (Task 8)
  - `shortHash` from `src/utils/format.ts`
- Produces:
  - The `FoodsCallback` union:
    - `{ action: "add"; ownerId }`
    - `{ action: "save"; ownerId; token }`
    - `{ action: "cxl"; ownerId; token }`
    - `{ action: "tog"; ownerId; index; token }`
    - `{ action: "log"; ownerId; logId }`
  - `encodeFoodsCallback(cb): string` and `parseFoodsCallback(data): FoodsCallback | null`, with the `foods:` prefix
  - `interface FoodsDeps { enabled; library; foodLogs: Pick<FoodLogsRepository, "getItemsByLog">; ai: Pick<AIService, "parseFoods">; users: Pick<UsersRepository, "findById">; analytics: Analytics; miniAppUrl: string }`
  - `createFoodsCommand(deps)`, `createFoodsMessageHandler(deps)`, `createFoodsCallbackHandler(deps)`
  - `isAwaitingFoodsPaste(userId)`, `stopAwaitingPaste(userId)`, `resetFoodsStates()` (test-only)
  - Exported copy constants `NOT_AVAILABLE`, `PRIVATE_ONLY`, `PASTE_PROMPT`, `PARSE_FAILED`, `NOTHING_FOUND`, `EXPIRED`
  - PostHog event `foods_added` with `{ count, replaced, source }`
  - The `"log"` action is answered as expired in this task; Task 10 implements it.

- [ ] **Step 1: Write the failing tests**

Append to `src/bot/utils/callback-data.test.ts` (add `encodeFoodsCallback, parseFoodsCallback` to its import):

```ts
describe("foods callbacks", () => {
  test.each([
    { action: "add" as const, ownerId: 42 },
    { action: "save" as const, ownerId: 42, token: "0123abcd" },
    { action: "cxl" as const, ownerId: 42, token: "0123abcd" },
    { action: "tog" as const, ownerId: 42, index: 3, token: "0123abcd" },
    { action: "log" as const, ownerId: 42, logId: 9001 },
  ])("round-trips %p within 64 bytes", (cb) => {
    const data = encodeFoodsCallback(cb)
    expect(data.startsWith("foods:")).toBe(true)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseFoodsCallback(data)).toEqual(cb)
  })

  test.each(["foods:save:42", "foods:save:42:XYZ", "foods:tog:42:x:0123abcd", "foods:log:abc:1", "foods:zap:42", "log:ok:42:0123abcd"])(
    "rejects %p",
    (data) => {
      expect(parseFoodsCallback(data)).toBeNull()
    }
  )
})
```

`src/bot/commands/foods.test.ts`:

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLibraryRepository } from "../../db/repositories/food-library"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { FakeAnalytics } from "../../analytics/test-helpers"
import type { ParsedFoodsReply } from "../../ai/types"
import { encodeFoodsCallback, parseFoodsCallback } from "../utils/callback-data"
import {
  createFoodsCallbackHandler,
  createFoodsCommand,
  createFoodsMessageHandler,
  isAwaitingFoodsPaste,
  resetFoodsStates,
  stopAwaitingPaste,
  EXPIRED,
  NOT_AVAILABLE,
  PARSE_FAILED,
  PASTE_PROMPT,
  PRIVATE_ONLY,
  type FoodsDeps,
} from "./foods"

const OWNER = 42
const OTHER = 99

const OATS_ROW = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
const SKY_ROW = { name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 3.5, fiber_g: null, added_sugar_g: 1 }

let library: FoodLibraryRepository
let foodLogs: FoodLogsRepository
let analytics: FakeAnalytics
let parseFoods: ReturnType<typeof mock>
let deps: FoodsDeps

beforeEach(() => {
  resetFoodsStates()
  const db = createTestDb()
  const users = new UsersRepository(db)
  users.upsert(OWNER, "maria")
  users.upsert(OTHER, "bob")
  library = new FoodLibraryRepository(db)
  foodLogs = new FoodLogsRepository(db)
  analytics = new FakeAnalytics()
  parseFoods = mock(async (): Promise<ParsedFoodsReply> => ({ foods: [OATS_ROW, SKY_ROW], unreadable: [] }))
  deps = {
    enabled: true,
    library,
    foodLogs,
    ai: { parseFoods } as unknown as FoodsDeps["ai"],
    users,
    analytics,
    miniAppUrl: "https://telecal.example/app",
  }
})

function commandCtx(text: string, opts: { fromId?: number; chatType?: string } = {}) {
  return {
    from: { id: opts.fromId ?? OWNER, first_name: "Maria" },
    chat: { id: 555, type: opts.chatType ?? "private" },
    message: { text, message_id: 1 },
    reply: mock(() => Promise.resolve()),
  }
}

function callbackCtx(data: string, fromId = OWNER) {
  return {
    from: { id: fromId, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    editMessageReplyMarkup: mock(() => Promise.resolve(true)),
    reply: mock(() => Promise.resolve()),
  }
}

async function run(text: string, opts?: { fromId?: number; chatType?: string }) {
  const ctx = commandCtx(text, opts)
  await createFoodsCommand(deps)(ctx as unknown as Context)
  return ctx
}

async function send(text: string, fromId = OWNER) {
  const ctx = commandCtx(text, { fromId })
  await createFoodsMessageHandler(deps)(ctx as unknown as Context)
  return ctx
}

async function press(data: string, fromId = OWNER) {
  const ctx = callbackCtx(data, fromId)
  await createFoodsCallbackHandler(deps)(ctx as unknown as Context)
  return ctx
}

/** The callback data of every button on the last reply, flattened. */
function buttons(ctx: { reply: ReturnType<typeof mock> }): { text: string; data?: string; url?: string }[] {
  const options = ctx.reply.mock.calls.at(-1)?.[1] as { reply_markup?: { inline_keyboard: any[][] } } | undefined
  return (options?.reply_markup?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.web_app?.url }))
}

function saveData(ctx: { reply: ReturnType<typeof mock> }): string {
  return buttons(ctx).find((b) => b.text.startsWith("Save"))!.data!
}

describe("/foods", () => {
  test("off: says it isn't available", async () => {
    deps.enabled = false
    const ctx = await run("/foods")
    expect(ctx.reply).toHaveBeenCalledWith(NOT_AVAILABLE, undefined)
  })

  test("in a group: points to a private chat", async () => {
    const ctx = await run("/foods", { chatType: "group" })
    expect(ctx.reply.mock.calls[0][0]).toContain(PRIVATE_ONLY)
  })

  test("the hub shows the count, Add foods and Open my foods", async () => {
    library.upsertMany(OWNER, [{ ...(OATS_ROW as any), serving_unit: "g" }], "import")
    const ctx = await run("/foods")
    expect(ctx.reply.mock.calls[0][0]).toBe("You have 1 food saved.")
    expect(buttons(ctx)).toEqual([
      { text: "Add foods", data: encodeFoodsCallback({ action: "add", ownerId: OWNER }), url: undefined },
      { text: "Open my foods", data: undefined, url: "https://telecal.example/app?tab=foods" },
    ])
  })

  test("an empty library says so", async () => {
    const ctx = await run("/foods")
    expect(ctx.reply.mock.calls[0][0]).toBe("No saved foods yet.")
  })

  test("/foods add with no text waits for a paste; a command stops waiting", async () => {
    const ctx = await run("/foods add")
    expect(ctx.reply).toHaveBeenCalledWith(PASTE_PROMPT, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(true)
    stopAwaitingPaste(OWNER)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("/foods add <text> goes straight to a preview, with nothing saved yet", async () => {
    const ctx = await run("/foods add Oats 1/2 cup 40g 150 kcal")
    expect(parseFoods).toHaveBeenCalledWith("Oats 1/2 cup 40g 150 kcal", "gemini", { telegramId: OWNER, chatId: 555 })
    expect(ctx.reply.mock.calls[0][0]).toStartWith("Found 2 foods (per serving):\n1. Quaker Oats")
    expect(buttons(ctx).map((b) => b.text)).toEqual(["Save 2", "Cancel"])
    expect(library.count(OWNER)).toBe(0)
  })
})

describe("paste → preview → Save", () => {
  test("Save writes the rows and reports foods_added", async () => {
    await run("/foods add")
    const preview = await send("Quaker Oats 150 kcal ...")
    const saved = await press(saveData(preview))

    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
    expect(library.listByUser(OWNER)[0].source).toBe("import")
    expect(saved.editMessageText.mock.calls[0][0]).toBe("Saved 2 foods. You have 2 foods.")
    expect(analytics.events).toEqual([
      { telegramId: OWNER, event: "foods_added", properties: { count: 2, replaced: 0, source: "import" } },
    ])
  })

  test("a replacement is counted and said", async () => {
    library.upsertMany(OWNER, [{ ...(SKY_ROW as any) }], "import")
    const preview = await run("/foods add skyflakes")
    expect(preview.reply.mock.calls[0][0]).toContain("(replaces your saved one)")
    const saved = await press(saveData(preview))
    expect(saved.editMessageText.mock.calls[0][0]).toBe("Saved 2 foods (1 replaced). You have 2 foods.")
  })

  test("Cancel writes nothing", async () => {
    const preview = await run("/foods add x")
    const cancel = buttons(preview).find((b) => b.text === "Cancel")!.data!
    const ctx = await press(cancel)
    expect(library.count(OWNER)).toBe(0)
    expect(ctx.editMessageText.mock.calls[0][0]).toBe("Cancelled. Nothing saved.")
  })

  test("an old preview's Save is refused once a newer preview exists", async () => {
    const first = await run("/foods add x")
    parseFoods.mockImplementation(async () => ({ foods: [OATS_ROW], unreadable: [] }))
    await run("/foods add y")
    const ctx = await press(saveData(first))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(EXPIRED)
    expect(library.count(OWNER)).toBe(0)
  })

  test("someone else's press is refused", async () => {
    const preview = await run("/foods add x")
    const ctx = await press(saveData(preview), OTHER)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can use these buttons.")
    expect(library.count(OWNER)).toBe(0)
    expect(library.count(OTHER)).toBe(0)
  })

  test("a failed parse says so and keeps nothing", async () => {
    parseFoods.mockImplementation(async () => {
      throw new Error("down")
    })
    await run("/foods add")
    const ctx = await send("anything")
    expect(ctx.reply).toHaveBeenCalledWith(PARSE_FAILED, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("nothing usable: says what a row needs and lists what it couldn't read", async () => {
    parseFoods.mockImplementation(async () => ({ foods: [], unreadable: [{ text: "lunch adobo", reason: "no calories" }] }))
    const ctx = await run("/foods add lunch adobo")
    expect(ctx.reply.mock.calls[0][0]).toBe(
      'I couldn\'t find any foods in that. Each one needs a name, a serving and calories.\nCouldn\'t read: "lunch adobo" (no calories)'
    )
  })

  test("cancel while waiting for a paste", async () => {
    await run("/foods add")
    const ctx = await send("cancel")
    expect(ctx.reply).toHaveBeenCalledWith("Cancelled.", undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("the Add foods button waits for a paste", async () => {
    const ctx = await press(encodeFoodsCallback({ action: "add", ownerId: OWNER }))
    expect(ctx.reply).toHaveBeenCalledWith(PASTE_PROMPT, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(true)
  })
})

test("parseFoodsCallback reads what the preview sends", async () => {
  const preview = await run("/foods add x")
  expect(parseFoodsCallback(saveData(preview))).toMatchObject({ action: "save", ownerId: OWNER })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/bot/utils/callback-data.test.ts src/bot/commands/foods.test.ts`
Expected: FAIL. `encodeFoodsCallback` and `./foods` are missing.

- [ ] **Step 3: Implement**

`src/bot/utils/callback-data.ts`: change the header comment's first line to `// Payload formats for the /log, /delete and /foods buttons. Every button` and append:

```ts
export type FoodsCallback =
  | { action: "add"; ownerId: number }
  | { action: "save"; ownerId: number; token: string }
  | { action: "cxl"; ownerId: number; token: string }
  | { action: "tog"; ownerId: number; index: number; token: string }
  | { action: "log"; ownerId: number; logId: number }

export function encodeFoodsCallback(cb: FoodsCallback): string {
  switch (cb.action) {
    case "add":
      return `foods:add:${cb.ownerId}`
    case "save":
      return `foods:save:${cb.ownerId}:${cb.token}`
    case "cxl":
      return `foods:cxl:${cb.ownerId}:${cb.token}`
    case "tog":
      return `foods:tog:${cb.ownerId}:${cb.index}:${cb.token}`
    case "log":
      return `foods:log:${cb.ownerId}:${cb.logId}`
  }
}

export function parseFoodsCallback(data: string): FoodsCallback | null {
  const parts = data.split(":")
  if (parts[0] !== "foods") return null

  const ownerId = parseId(parts[2])
  if (ownerId === null) return null

  switch (parts[1]) {
    case "add":
      return parts.length === 3 ? { action: "add", ownerId } : null
    case "save":
    case "cxl": {
      if (parts.length !== 4 || !TOKEN.test(parts[3])) return null
      return { action: parts[1] as "save" | "cxl", ownerId, token: parts[3] }
    }
    case "tog": {
      if (parts.length !== 5 || !TOKEN.test(parts[4])) return null
      const index = parseId(parts[3])
      return index === null ? null : { action: "tog", ownerId, index, token: parts[4] }
    }
    case "log": {
      if (parts.length !== 4) return null
      const logId = parseId(parts[3])
      return logId === null ? null : { action: "log", ownerId, logId }
    }
    default:
      return null
  }
}
```

`src/bot/commands/foods.ts`:

```ts
// src/bot/commands/foods.ts
// /foods: the hub, adding foods by paste or /foods add, and the preview every
// save goes through (nothing enters the library without a Save tap). Browsing,
// editing and deleting live in the Mini App's Foods tab. State is in memory,
// like /edit and /delete: a restart loses a preview and its Save says so.
import { Context, InlineKeyboard } from "grammy"
import type { AIService } from "../../ai/service"
import type { FoodLibraryRepository } from "../../db/repositories/food-library"
import type { FoodLogsRepository } from "../../db/repositories/food-logs"
import type { UsersRepository } from "../../db/repositories/users"
import type { Analytics } from "../../analytics"
import type { FoodSource } from "../../library/types"
import { formatPreview, importPreview, type Preview } from "../../library/preview"
import { shortHash } from "../../utils/format"
import { encodeFoodsCallback, parseFoodsCallback } from "../utils/callback-data"
import { answerCallback, stripKeyboard } from "../utils/keyboard"
import { smartEdit, smartReply } from "../utils/smart-reply"

export interface FoodsDeps {
  /** FEATURE_LOCAL_FOOD_DB */
  enabled: boolean
  library: FoodLibraryRepository
  foodLogs: Pick<FoodLogsRepository, "getItemsByLog">
  ai: Pick<AIService, "parseFoods">
  users: Pick<UsersRepository, "findById">
  /** The Analytics createBot returns. */
  analytics: Analytics
  /** config.web.miniAppUrl */
  miniAppUrl: string
}

export const NOT_AVAILABLE = "Saved foods aren't available yet."
export const PRIVATE_ONLY = "Open me in a private chat to manage your foods."
export const PASTE_PROMPT = "Paste one food or a whole table. Values per serving."
export const PARSE_FAILED = "Couldn't read that right now. Try again in a bit."
export const NOTHING_FOUND = "I couldn't find any foods in that. Each one needs a name, a serving and calories."
export const EXPIRED = "This preview expired, paste again."
const NOT_OWNER = "Only the person who started this can use these buttons."

type PreviewState = { mode: "preview"; source: FoodSource; preview: Preview; on: boolean[]; token: string }
type FoodsState = { mode: "awaiting_paste" } | PreviewState

const foodsStates = new Map<number, FoodsState>()

export function isAwaitingFoodsPaste(userId: number): boolean {
  return foodsStates.get(userId)?.mode === "awaiting_paste"
}

/** Any command stops waiting for a paste (src/bot/index.ts calls this for every command). */
export function stopAwaitingPaste(userId: number): void {
  if (isAwaitingFoodsPaste(userId)) foodsStates.delete(userId)
}

/** Test-only. */
export function resetFoodsStates(): void {
  foodsStates.clear()
}

function isGroup(ctx: Context): boolean {
  const type = ctx.chat?.type
  return type === "group" || type === "supergroup"
}

function plural(n: number): string {
  return n === 1 ? "food" : "foods"
}

function foodsUrl(deps: FoodsDeps): string {
  return `${deps.miniAppUrl}?tab=foods`
}

function previewHeader(source: FoodSource, rows: number): string {
  return source === "log"
    ? "Save to your foods? Values are per serving, as logged."
    : `Found ${rows} ${plural(rows)} (per serving):`
}

function previewKeyboard(ownerId: number, state: PreviewState): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (state.source === "log") {
    state.on.forEach((on, index) => {
      keyboard.text(on ? `${index + 1} ✓` : `${index + 1}`, encodeFoodsCallback({ action: "tog", ownerId, index, token: state.token }))
      if ((index + 1) % 8 === 0) keyboard.row()
    })
    keyboard.row()
  }
  const count = state.on.filter(Boolean).length
  return keyboard
    .text(`Save ${count}`, encodeFoodsCallback({ action: "save", ownerId, token: state.token }))
    .text("Cancel", encodeFoodsCallback({ action: "cxl", ownerId, token: state.token }))
}

/** Shows a preview and remembers it; its buttons carry a fingerprint of the rows it showed. */
export async function showPreview(ctx: Context, ownerId: number, source: FoodSource, preview: Preview): Promise<void> {
  const state: PreviewState = {
    mode: "preview",
    source,
    preview,
    on: preview.rows.map(() => true),
    token: shortHash(JSON.stringify(preview.rows)),
  }
  foodsStates.set(ownerId, state)
  await smartReply(ctx, formatPreview(previewHeader(source, preview.rows.length), preview), {
    reply_markup: previewKeyboard(ownerId, state),
  })
}

async function runImport(ctx: Context, deps: FoodsDeps, userId: number, text: string, source: "import" | "single"): Promise<void> {
  const provider = deps.users.findById(userId)?.ai_provider ?? "openai"
  let reply
  try {
    reply = await deps.ai.parseFoods(text, provider, { telegramId: userId, chatId: ctx.chat?.id ?? null })
  } catch {
    // AIService has already recorded and reported the failure.
    foodsStates.delete(userId)
    await smartReply(ctx, PARSE_FAILED)
    return
  }

  const preview = importPreview(reply, deps.library.listByUser(userId))
  if (preview.rows.length === 0) {
    foodsStates.delete(userId)
    await smartReply(ctx, `${NOTHING_FOUND}${formatPreview("", preview)}`.trimEnd())
    return
  }
  await showPreview(ctx, userId, source, preview)
}

export function createFoodsCommand(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return
    if (!deps.enabled) return smartReply(ctx, NOT_AVAILABLE)
    if (isGroup(ctx)) return smartReply(ctx, PRIVATE_ONLY)

    // Everything after "/foods" or "/foods@Bot", line breaks included.
    const args = (ctx.message?.text ?? "").replace(/^\/\S+\s*/, "")
    const add = args.match(/^add\b\s*([\s\S]*)$/i)
    if (add) {
      const text = add[1].trim()
      if (!text) {
        foodsStates.set(userId, { mode: "awaiting_paste" })
        return smartReply(ctx, PASTE_PROMPT)
      }
      return runImport(ctx, deps, userId, text, "single")
    }

    const count = deps.library.count(userId)
    const keyboard = new InlineKeyboard()
      .text("Add foods", encodeFoodsCallback({ action: "add", ownerId: userId }))
      .webApp("Open my foods", foodsUrl(deps))
    await smartReply(ctx, count === 0 ? "No saved foods yet." : `You have ${count} ${plural(count)} saved.`, {
      reply_markup: keyboard,
    })
  }
}

export function createFoodsMessageHandler(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    const text = ctx.message?.text?.trim()
    if (!userId || !text || !isAwaitingFoodsPaste(userId)) return

    if (text.startsWith("/")) {
      foodsStates.delete(userId)
      return
    }
    if (text.toLowerCase() === "cancel") {
      foodsStates.delete(userId)
      return smartReply(ctx, "Cancelled.")
    }
    await runImport(ctx, deps, userId, text, "import")
  }
}

function currentPreview(userId: number, token: string): PreviewState | null {
  const state = foodsStates.get(userId)
  return state?.mode === "preview" && state.token === token ? state : null
}

async function expired(ctx: Context): Promise<void> {
  await answerCallback(ctx, EXPIRED)
  await stripKeyboard(ctx)
}

async function editOrReply(ctx: Context, text: string, options?: Parameters<Context["editMessageText"]>[1]): Promise<void> {
  try {
    await smartEdit(ctx, text, options)
  } catch (error) {
    console.error("Failed to edit foods message:", error)
    await smartReply(ctx, text, options as Parameters<Context["reply"]>[1])
  }
}

async function save(ctx: Context, deps: FoodsDeps, userId: number, token: string): Promise<void> {
  const state = currentPreview(userId, token)
  if (!state) return expired(ctx)

  const foods = state.preview.rows.filter((_, i) => state.on[i]).map((row) => row.food)
  if (foods.length === 0) {
    await answerCallback(ctx, "Nothing selected.")
    return
  }

  const { added, replaced } = deps.library.upsertMany(userId, foods, state.source)
  foodsStates.delete(userId)
  deps.analytics.capture(userId, "foods_added", { count: added + replaced, replaced, source: state.source })

  await answerCallback(ctx, "Saved")
  const total = deps.library.count(userId)
  const text =
    `Saved ${foods.length} ${plural(foods.length)}${replaced ? ` (${replaced} replaced)` : ""}. ` +
    `You have ${total} ${plural(total)}.`
  // Telegram refuses web_app buttons in groups.
  await editOrReply(ctx, text, isGroup(ctx) ? undefined : { reply_markup: new InlineKeyboard().webApp("Open my foods", foodsUrl(deps)) })
}

export function createFoodsCallbackHandler(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    const parsed = parseFoodsCallback(ctx.callbackQuery?.data ?? "")
    if (!presserId || !parsed || !deps.enabled) {
      await answerCallback(ctx, "That button has expired.")
      await stripKeyboard(ctx)
      return
    }
    // Owner check first, so a non-owner learns nothing about the owner's state.
    if (parsed.ownerId !== presserId) {
      await answerCallback(ctx, NOT_OWNER)
      return
    }

    switch (parsed.action) {
      case "add":
        foodsStates.set(presserId, { mode: "awaiting_paste" })
        await answerCallback(ctx)
        await smartReply(ctx, PASTE_PROMPT)
        return
      case "cxl": {
        if (!currentPreview(presserId, parsed.token)) return expired(ctx)
        foodsStates.delete(presserId)
        await answerCallback(ctx, "Cancelled")
        await editOrReply(ctx, "Cancelled. Nothing saved.")
        return
      }
      case "tog": {
        const state = currentPreview(presserId, parsed.token)
        if (!state || parsed.index >= state.on.length) return expired(ctx)
        state.on[parsed.index] = !state.on[parsed.index]
        await answerCallback(ctx)
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: previewKeyboard(presserId, state) })
        } catch (error) {
          console.error("Failed to update foods preview keyboard:", error)
        }
        return
      }
      case "save":
        return save(ctx, deps, presserId, parsed.token)
      case "log":
        // Save from a log: Task 10.
        return expired(ctx)
    }
  }
}
```

`src/bot/index.ts`:

- Import:

```ts
import {
  createFoodsCommand,
  createFoodsMessageHandler,
  createFoodsCallbackHandler,
  isAwaitingFoodsPaste,
  stopAwaitingPaste,
  type FoodsDeps,
} from "./commands/foods"
```

- After the `usersRepo.upsert` middleware:

```ts
  // Any command stops /foods waiting for a paste, so the next message isn't taken as one.
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.message?.text?.startsWith("/")) stopAwaitingPaste(ctx.from.id)
    return next()
  })
```

- Build the deps after `logFlow` and register the command beside the others:

```ts
  const foodsDeps: FoodsDeps = {
    enabled: foodLibraryEnabled,
    library: foodLibraryRepo,
    foodLogs: foodLogsRepo,
    ai: aiService,
    users: usersRepo,
    analytics,
    miniAppUrl: config.web.miniAppUrl,
  }
```

```ts
  bot.command("foods", createFoodsCommand(foodsDeps))
```

- In the `callback_query:data` router, before `return next()`:

```ts
    if (data?.startsWith("foods:")) {
      return createFoodsCallbackHandler(foodsDeps)(ctx)
    }
```

- In the `message:text` router: create `const foodsMessageHandler = createFoodsMessageHandler(foodsDeps)` with the other handlers, update the comment to `// Priority order: settings > delete > edit > foods paste > log conversation`, and before the log fallback add:

```ts
    if (isAwaitingFoodsPaste(userId)) {
      return foodsMessageHandler(ctx)
    }
```

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/utils/callback-data.ts src/bot/utils/callback-data.test.ts src/bot/commands/foods.ts src/bot/commands/foods.test.ts src/bot/index.ts
git commit -m "$(cat <<'EOF'
feat(foods): /foods hub, paste or /foods add, preview and Save (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Save from a log

**Files:**
- Modify: `src/bot/commands/log.ts`, `src/bot/commands/log.test.ts`
- Modify: `src/bot/commands/foods.ts`, `src/bot/commands/foods.test.ts`

**Interfaces:**
- Consumes:
  - `LogFlowResult.saveOffer` and `ConfirmationOutcome.saveOffer` (Task 7)
  - `encodeFoodsCallback` with `action: "log"` (Task 9)
  - `logPreview` (Task 8)
  - `FoodLogsRepository.getItemsByLog` (Task 2)
  - `showPreview` (Task 9)
- Produces:
  - `saveToFoodsKeyboard(ownerId: number, logId: number): InlineKeyboard` in `log.ts`
  - The "Logged" message (typed yes and the Log button) carries "Save to my foods" whenever `saveOffer` is set
  - `foods:log:<owner>:<logId>` opens a preview with on/off toggles, saved with source `"log"`

- [ ] **Step 1: Write the failing tests**

Append to `src/bot/commands/log.test.ts` (add `saveToFoodsKeyboard` to the `./log` import and `encodeFoodsCallback` from `../utils/callback-data`):

```ts
describe("Save to my foods", () => {
  test("the Log button's edit carries the button when the outcome offers it", async () => {
    const { ctx } = await press(
      encodeLogCallback({ action: "ok", ownerId: 42, token: "0123abcd" }),
      { ...LOGGED, saveOffer: { logId: 77 } }
    )
    const options = ctx.editMessageText.mock.calls[0][1] as any
    expect(options.reply_markup.inline_keyboard).toEqual([
      [{ text: "Save to my foods", callback_data: encodeFoodsCallback({ action: "log", ownerId: 42, logId: 77 }) }],
    ])
  })

  test("without an offer the edit has no keyboard", async () => {
    const { ctx } = await press(encodeLogCallback({ action: "ok", ownerId: 42, token: "0123abcd" }), LOGGED)
    expect(ctx.editMessageText.mock.calls[0][1]).toEqual({ parse_mode: "HTML" })
  })

  test("saveToFoodsKeyboard", () => {
    expect(saveToFoodsKeyboard(42, 77).inline_keyboard[0][0]).toMatchObject({ text: "Save to my foods" })
  })
})
```

If `encodeLogCallback` isn't already imported in `log.test.ts`, add it to the `../utils/callback-data` import.

Append to `src/bot/commands/foods.test.ts`:

```ts
describe("save from a log", () => {
  function logged(items: Parameters<FoodLogsRepository["create"]>[3], owner = OWNER) {
    return foodLogs.create(owner, 555, "2026-11-08", items)
  }

  test("previews the log's items with toggles, leaving out items from saved foods; Save stores only the ones on", async () => {
    const log = logged([
      { description: "Chicken adobo (1 cup)", calories: 350, protein_g: 30, emoji: "🍗" },
      { description: "Garlic rice (1 cup)", calories: 300, protein_g: 5, emoji: "🍚" },
      { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 1 },
    ])
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))

    expect(ctx.reply.mock.calls[0][0]).toStartWith("Save to your foods? Values are per serving, as logged.\n1. Chicken adobo (1 cup)")
    expect(ctx.reply.mock.calls[0][0]).not.toContain("Quaker Oats")
    expect(buttons(ctx).map((b) => b.text)).toEqual(["1 ✓", "2 ✓", "Save 2", "Cancel"])

    const toggle = buttons(ctx).find((b) => b.text === "2 ✓")!.data!
    const toggled = await press(toggle)
    const markup = (toggled.editMessageReplyMarkup.mock.calls[0][0] as any).reply_markup.inline_keyboard.flat()
    expect(markup.map((b: any) => b.text)).toEqual(["1 ✓", "2", "Save 1", "Cancel"])

    await press(saveData(ctx))
    const saved = library.listByUser(OWNER)
    expect(saved.map((f) => [f.name, f.serving, f.source])).toEqual([["Chicken adobo (1 cup)", "as logged", "log"]])
  })

  test("a log made only of saved foods: says so", async () => {
    const log = logged([{ description: "Quaker Oats ×2", calories: 300, saved_food_id: 1 }])
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("These are already in your foods.")
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test("someone else's log shows nothing", async () => {
    const log = logged([{ description: "Banana", calories: 105 }], OTHER)
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer there.")
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
```

`buttons(ctx)` reads `ctx.reply`, which exists on the callback fake too.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/bot/commands/log.test.ts src/bot/commands/foods.test.ts`
Expected: FAIL. `saveToFoodsKeyboard` is missing and the `log` press answers expired.

- [ ] **Step 3: Implement**

`src/bot/commands/log.ts`: import `encodeFoodsCallback` from `../utils/callback-data` and add:

```ts
/** On a "Logged" message when the food library is on. */
export function saveToFoodsKeyboard(ownerId: number, logId: number): InlineKeyboard {
  return new InlineKeyboard().text("Save to my foods", encodeFoodsCallback({ action: "log", ownerId, logId }))
}
```

In `replyWithResult`:

```ts
  if (result.confirm) options.reply_markup = buildLogConfirmKeyboard(ownerId, result.confirm)
  if (result.saveOffer) options.reply_markup = saveToFoodsKeyboard(ownerId, result.saveOffer.logId)
```

In `createLogCallbackHandler`, replace the edit block:

```ts
    // Answer before editing so the client's spinner stops even if the edit fails.
    await answerCallback(ctx, outcome.toast)
    const options = {
      parse_mode: "HTML" as const,
      ...(outcome.saveOffer ? { reply_markup: saveToFoodsKeyboard(presserId, outcome.saveOffer.logId) } : {}),
    }
    try {
      await smartEdit(ctx, outcome.edit, options)
    } catch (error) {
      console.error("Failed to edit log confirmation:", error)
      await smartReply(ctx, outcome.edit, options)
    }
```

`src/bot/commands/foods.ts`: import `logPreview` alongside `importPreview`, then replace the `case "log":` branch with `return offerLog(ctx, deps, presserId, parsed.logId)` and add:

```ts
async function offerLog(ctx: Context, deps: FoodsDeps, userId: number, logId: number): Promise<void> {
  const items = deps.foodLogs.getItemsByLog(userId, logId)
  if (!items) {
    await answerCallback(ctx, "That entry is no longer there.")
    await stripKeyboard(ctx)
    return
  }
  const preview = logPreview(items, deps.library.listByUser(userId))
  if (preview.rows.length === 0) {
    await answerCallback(ctx, preview.unreadable.length > 0 ? "Couldn't read those items." : "These are already in your foods.")
    return
  }
  await answerCallback(ctx)
  await showPreview(ctx, userId, "log", preview)
}
```

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/log.ts src/bot/commands/log.test.ts src/bot/commands/foods.ts src/bot/commands/foods.test.ts
git commit -m "$(cat <<'EOF'
feat(foods): Save to my foods on a logged meal, with a preview (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Web API for the Foods tab

**Files:**
- Modify: `src/web/api.ts`, `src/web/api.test.ts`
- Modify: `src/web/server.ts`, `src/web/server.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes:
  - `FoodLibraryRepository` (Task 2)
  - `validateFood` (Task 1)
  - `createBot()` returning `foodLibraryRepo` (Task 7)
- Produces:
  - `ApiDeps` gains `foodLibrary?: FoodLibraryRepository` and `foodLibraryEnabled?: boolean`
  - `getUser` adds `food_library: boolean`
  - `type ApiResult = { status: number; body: unknown }`
  - `MAX_DELETE_IDS = 500`
  - Handlers: `listFoods(telegramId): ApiResult`, `updateFood(telegramId, id, patch: unknown): ApiResult`, `deleteFoods(telegramId, body: unknown): ApiResult`
  - `WebServerDeps` gains `foodLibraryRepo?` and `foodLibraryEnabled?`
  - Routes:
    - `GET /api/foods` → `{ foods }`
    - `PATCH /api/foods/:id` → 200 `{ food }` | 400 `{ error }` | 404 | 409 `{ error }`
    - `DELETE /api/foods` with body `{ ids }` → 200 `{ deleted }` | 400 | 404
    - other methods → 405
  - Food payload: `{ id, name, serving, serving_amount, serving_unit, calories, protein_g, fat_g, fiber_g, added_sugar_g }`

- [ ] **Step 1: Write the failing tests**

In `src/web/api.test.ts`, add `food_library: false,` to the exact object in the "adds daily_protein_goal beside daily_goal" test (after `analytics_id: null,`). Add `import { FoodLibraryRepository } from "../db/repositories/food-library"` to the file's imports, then append:

```ts
describe("food library", () => {
  const OATS = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g" as const, calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
  let library: FoodLibraryRepository
  let foodsApi: ReturnType<typeof createApiHandlers>

  beforeEach(() => {
    const db = createTestDb()
    library = new FoodLibraryRepository(db)
    const users = new UsersRepository(db)
    users.upsert(USER, "maria")
    foodsApi = createApiHandlers({ usersRepo: users, foodLogsRepo: new FoodLogsRepository(db), foodLibrary: library, foodLibraryEnabled: true })
    library.upsertMany(USER, [OATS, { ...OATS, name: "Skyflakes", calories: 110 }], "import")
  })

  test("getUser says whether the library is on", () => {
    expect(foodsApi.getUser(USER).food_library).toBe(true)
    expect(api.getUser(USER).food_library).toBe(false)
  })

  test("off: every foods route is 404", () => {
    const off = createApiHandlers({ usersRepo, foodLogsRepo, foodLibrary: library, foodLibraryEnabled: false })
    expect(off.listFoods(USER).status).toBe(404)
    expect(off.updateFood(USER, 1, {}).status).toBe(404)
    expect(off.deleteFoods(USER, { ids: [1] }).status).toBe(404)
  })

  test("listFoods: A–Z, every field", () => {
    const result = foodsApi.listFoods(USER)
    expect(result.status).toBe(200)
    const foods = (result.body as { foods: any[] }).foods
    expect(foods.map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
    expect(foods[0]).toEqual({ id: foods[0].id, ...OATS })
    expect(foodsApi.listFoods(999).body).toEqual({ foods: [] })
  })

  test("updateFood: changes only the fields sent, validated", () => {
    const id = library.listByUser(USER)[0].id
    const ok = foodsApi.updateFood(USER, id, { calories: 160, fiber_g: null, unknown_field: 1 })
    expect(ok.status).toBe(200)
    expect((ok.body as any).food).toMatchObject({ name: "Quaker Oats", calories: 160, fiber_g: null, protein_g: 5 })

    expect(foodsApi.updateFood(USER, id, { calories: 9999 })).toEqual({ status: 400, body: { error: "calories out of range" } })
    expect(foodsApi.updateFood(USER, id, "nope").status).toBe(400)
    expect(foodsApi.updateFood(999, id, { calories: 1 }).status).toBe(404)
    expect(foodsApi.updateFood(USER, id, { name: "skyflakes" })).toEqual({
      status: 409,
      body: { error: "You already have a food called skyflakes" },
    })
  })

  test("deleteFoods: all or nothing, ids checked", () => {
    const [oats, sky] = library.listByUser(USER)
    expect(foodsApi.deleteFoods(USER, { ids: [] }).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, { ids: ["1"] }).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, null).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }).status).toBe(400)
    expect(foodsApi.deleteFoods(999, { ids: [oats.id] }).status).toBe(404)
    expect(library.count(USER)).toBe(2)
    expect(foodsApi.deleteFoods(USER, { ids: [oats.id, sky.id] })).toEqual({ status: 200, body: { deleted: 2 } })
    expect(library.count(USER)).toBe(0)
  })
})
```

Add `import { FoodLibraryRepository } from "../db/repositories/food-library"` to the imports of `src/web/server.test.ts`, then append:

```ts
describe("/api/foods", () => {
  const USER = { id: 42, first_name: "Maria" }
  let foodsHandle: (request: Request) => Promise<Response>
  let library: FoodLibraryRepository

  beforeEach(() => {
    const db = createTestDb()
    library = new FoodLibraryRepository(db)
    const users = new UsersRepository(db)
    users.upsert(42, "maria")
    library.upsertMany(42, [{ name: "Quaker Oats", serving: "1 serving", serving_amount: null, serving_unit: null, calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }], "import")
    foodsHandle = createFetchHandler({
      usersRepo: users,
      foodLogsRepo: new FoodLogsRepository(db),
      foodLibraryRepo: library,
      foodLibraryEnabled: true,
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
    })
  })

  function call(method: string, path: string, body?: unknown, auth = true) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (auth) headers.Authorization = `tg-init-data ${createValidInitData(USER, config.telegram.botToken)}`
    return foodsHandle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  }

  test("GET lists, PATCH edits, DELETE deletes", async () => {
    const list = await call("GET", "/api/foods")
    expect(list.status).toBe(200)
    const [oats] = (await list.json()).foods

    const patched = await call("PATCH", `/api/foods/${oats.id}`, { calories: 160 })
    expect(patched.status).toBe(200)
    expect((await patched.json()).food.calories).toBe(160)

    const deleted = await call("DELETE", "/api/foods", { ids: [oats.id] })
    expect(await deleted.json()).toEqual({ deleted: 1 })
  })

  test("a body that isn't JSON is a 400; a wrong method is a 405; no auth is a 401", async () => {
    const bad = await foodsHandle(
      new Request("http://localhost/api/foods", {
        method: "DELETE",
        headers: { Authorization: `tg-init-data ${createValidInitData(USER, config.telegram.botToken)}` },
        body: "not json",
      })
    )
    expect(bad.status).toBe(400)
    expect((await call("POST", "/api/foods", {})).status).toBe(405)
    expect((await call("GET", "/api/foods/1")).status).toBe(405)
    expect((await call("GET", "/api/foods", undefined, false)).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/web`
Expected: FAIL. `food_library` is missing, `listFoods` is not a function, and the routes 404.

- [ ] **Step 3: Implement**

`src/web/api.ts`: add imports:

```ts
import type { FoodLibraryRepository } from "../db/repositories/food-library"
import { validateFood } from "../library/validate"
import type { SavedFood } from "../library/types"
```

Extend `ApiDeps`:

```ts
  /** The food library (Foods tab); its routes 404 unless foodLibraryEnabled. */
  foodLibrary?: FoodLibraryRepository
  /** FEATURE_LOCAL_FOOD_DB */
  foodLibraryEnabled?: boolean
```

Add module-level helpers:

```ts
export type ApiResult = { status: number; body: unknown }
export const MAX_DELETE_IDS = 500

/** The fields a PATCH may change. Anything else in the body is ignored. */
const FOOD_FIELDS = ["name", "serving", "serving_amount", "serving_unit", "calories", ...MACROS.map((m) => m.column)]
const NOT_FOUND: ApiResult = { status: 404, body: { error: "Not found" } }

function foodPayload(food: SavedFood) {
  return {
    id: food.id,
    name: food.name,
    serving: food.serving,
    serving_amount: food.serving_amount,
    serving_unit: food.serving_unit,
    calories: food.calories,
    ...macroValuesOf(food),
  }
}
```

In `createApiHandlers`, after the destructuring line:

```ts
  const library = deps.foodLibraryEnabled && deps.foodLibrary ? deps.foodLibrary : null
```

In `getUser`'s returned object, after `analytics_id`:

```ts
        // Shows the Foods tab. A Telegram-cached page that predates this ignores it.
        food_library: library !== null,
```

and add these handlers to the returned object:

```ts
    listFoods(telegramId: number): ApiResult {
      if (!library) return NOT_FOUND
      return { status: 200, body: { foods: library.listByUser(telegramId).map(foodPayload) } }
    },

    updateFood(telegramId: number, id: number, patch: unknown): ApiResult {
      if (!library) return NOT_FOUND
      const existing = library.get(telegramId, id)
      if (!existing) return NOT_FOUND
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return { status: 400, body: { error: "Expected a JSON object" } }
      }
      const merged: Record<string, unknown> = { ...foodPayload(existing) }
      for (const key of FOOD_FIELDS) if (key in patch) merged[key] = (patch as Record<string, unknown>)[key]
      const result = validateFood(merged)
      if (!result.ok) return { status: 400, body: { error: result.reason } }
      const outcome = library.update(telegramId, id, result.food)
      if (outcome === "not_found") return NOT_FOUND
      if (outcome === "name_taken") {
        return { status: 409, body: { error: `You already have a food called ${result.food.name}` } }
      }
      return { status: 200, body: { food: foodPayload(library.get(telegramId, id)!) } }
    },

    deleteFoods(telegramId: number, body: unknown): ApiResult {
      if (!library) return NOT_FOUND
      const ids = typeof body === "object" && body !== null ? (body as { ids?: unknown }).ids : undefined
      const valid =
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= MAX_DELETE_IDS &&
        ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
      if (!valid) return { status: 400, body: { error: `Expected ids: 1 to ${MAX_DELETE_IDS} food ids` } }
      const deleted = library.deleteMany(telegramId, ids as number[])
      if (deleted === "not_found") return NOT_FOUND
      return { status: 200, body: { deleted } }
    },
```

`src/web/server.ts`:

- Import `FoodLibraryRepository` (type) and `type ApiResult` from `./api`.
- Extend `WebServerDeps`:

```ts
  /** The food library; with foodLibraryEnabled, serves /api/foods. */
  foodLibraryRepo?: FoodLibraryRepository
  /** FEATURE_LOCAL_FOOD_DB */
  foodLibraryEnabled?: boolean
```

- In `createFetchHandler`:

```ts
  const api = createApiHandlers({
    usersRepo,
    foodLogsRepo,
    analyticsIdSecret,
    foodLibrary: deps.foodLibraryRepo,
    foodLibraryEnabled: deps.foodLibraryEnabled,
  })
```

and change the API call to `return handleApiRoute(request, path, url, user, api)`.

- Make `handleApiRoute` async and route the foods paths first:

```ts
async function handleApiRoute(
  request: Request,
  path: string,
  url: URL,
  user: TelegramUser,
  api: ReturnType<typeof createApiHandlers>
): Promise<Response> {
  // The Foods tab: the only routes that change data. Same-origin only (no CORS preflight is answered).
  if (path === "/api/foods") {
    if (request.method === "GET") return apiResult(api.listFoods(user.id))
    if (request.method === "DELETE") return apiResult(api.deleteFoods(user.id, await readJson(request)))
    return jsonResponse({ error: "Method not allowed" }, 405)
  }
  const foodMatch = path.match(/^\/api\/foods\/(\d+)$/)
  if (foodMatch) {
    if (request.method !== "PATCH") return jsonResponse({ error: "Method not allowed" }, 405)
    return apiResult(api.updateFood(user.id, Number(foodMatch[1]), await readJson(request)))
  }

  // Below here: the existing GET /api/user, /api/today, /api/stats and
  // /api/day/:date handlers and the final 404, exactly as they are now.
}

/** The request's JSON body, or null when it has none or it isn't JSON (the handlers answer 400). */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function apiResult(result: ApiResult): Response {
  return jsonResponse(result.body, result.status)
}
```

`src/index.ts`: destructure `foodLibraryRepo` from `createBot(analytics)` and pass it to `startWebServer`:

```ts
  foodLibraryRepo,
  foodLibraryEnabled: config.features.localFoodDb,
```

- [ ] **Step 4: Run the whole suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/api.test.ts src/web/server.ts src/web/server.test.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(web): /api/foods list, edit and delete for the Foods tab (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Mini App Foods tab

**Files:**
- Modify: `src/web/views/app.html`
- Modify: `src/web/app-page.test.ts`

**Interfaces:**
- Consumes:
  - `/api/user`'s `food_library`
  - `GET`, `PATCH` and `DELETE` `/api/foods` (Task 11)
- Produces: a hidden "Foods" tab, shown when `food_library` is true and opened by `?tab=foods`. It has search, a list, an edit form, delete for one food, and select-and-delete for many. Browser events `miniapp_food_edited` and `miniapp_foods_deleted` with `{ count }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/web/app-page.test.ts`:

```ts
describe("Foods tab", () => {
  test("is hidden until /api/user says the library is on, and ?tab=foods opens it", () => {
    expect(html).toContain('<button class="tab hidden" data-tab="foods" id="foods-tab">Foods</button>')
    expect(script).toContain("food_library")
    expect(script).toContain("get('tab')")
  })

  test("talks to /api/foods with PATCH and DELETE", () => {
    expect(script).toContain("'/api/foods'")
    expect(script).toContain("'PATCH'")
    expect(script).toContain("'DELETE'")
  })

  test("puts food names in the page as text, never as HTML", () => {
    expect(script).toContain("name.textContent = food.name")
    expect(script).not.toMatch(/innerHTML\s*=\s*`[^`]*food\.name/)
  })

  test("labels every macro on the edit form", () => {
    for (const m of MACROS) expect(script).toMatch(new RegExp(`${m.key}: \\{ column: '${m.column}',[^}]*form: '`))
  })

  test("uses no optional chaining or nullish coalescing (old Telegram webviews)", () => {
    expect(script).not.toContain("?.")
    expect(script).not.toContain("??")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/web/app-page.test.ts`
Expected: FAIL. There is no foods tab yet.

- [ ] **Step 3: Implement**

All edits are in `src/web/views/app.html`.

**3a. CSS**: add before `</style>`:

```css
    /* Foods tab */
    .tab.hidden,
    .foods-select.hidden,
    .foods-delete-bar.hidden,
    .food-form-error.hidden {
      display: none;
    }

    .foods-search {
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 10px;
      background: var(--secondary-bg);
      color: var(--text-color);
      font-size: 15px;
      margin-bottom: 8px;
    }

    .foods-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .foods-count {
      font-size: 13px;
      color: var(--hint-color);
    }

    .foods-select {
      border: none;
      background: none;
      color: var(--link-color);
      font-size: 15px;
      cursor: pointer;
    }

    .food-row {
      cursor: pointer;
    }

    .food-check {
      width: 18px;
      height: 18px;
      margin-right: 12px;
      pointer-events: none;
    }

    .foods-delete-bar {
      position: sticky;
      bottom: 0;
      padding: 12px 0;
      background: var(--bg-color);
    }

    .foods-button {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 10px;
      background: var(--button-color);
      color: var(--button-text);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }

    .foods-button.danger {
      background: transparent;
      color: var(--tg-theme-destructive-text-color, #e53935);
      border: 1px solid currentColor;
    }

    .foods-button:disabled {
      opacity: 0.5;
    }

    .food-form label {
      display: block;
      font-size: 13px;
      color: var(--hint-color);
      margin-bottom: 12px;
    }

    .food-form input,
    .food-form select {
      display: block;
      width: 100%;
      margin-top: 4px;
      padding: 10px 12px;
      border: none;
      border-radius: 10px;
      background: var(--secondary-bg);
      color: var(--text-color);
      font-size: 15px;
    }

    .food-form-row {
      display: flex;
      gap: 12px;
    }

    .food-form-row label {
      flex: 1;
    }

    .food-form-error {
      color: var(--tg-theme-destructive-text-color, #e53935);
      font-size: 14px;
      margin-bottom: 12px;
    }

    .food-form-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
```

**3b. Tab button**: in `<div class="tabs">`, after the Month button:

```html
    <button class="tab hidden" data-tab="foods" id="foods-tab">Foods</button>
```

**3c. Views**: after the `month-view` div closes:

```html
  <div id="foods-view" class="view">
    <input id="foods-search" class="foods-search" type="search" placeholder="Search foods" autocomplete="off">
    <div class="foods-toolbar">
      <span id="foods-count" class="foods-count"></span>
      <button id="foods-select" class="foods-select hidden" type="button">Select</button>
    </div>
    <div id="foods-list" class="food-log"></div>
    <div id="foods-delete-bar" class="foods-delete-bar hidden">
      <button id="foods-delete" class="foods-button danger" type="button">Delete 0</button>
    </div>
  </div>

  <div id="food-edit-view" class="view">
    <form id="food-form" class="food-form" novalidate>
      <label>Name<input name="name" type="text" maxlength="100"></label>
      <label>Serving<input name="serving" type="text" maxlength="100" placeholder="1/2 cup (40 g)"></label>
      <div class="food-form-row">
        <label>Amount<input name="serving_amount" type="number" min="0" step="any" inputmode="decimal"></label>
        <label>Unit<select name="serving_unit"><option value="">none</option><option value="g">g</option><option value="ml">ml</option></select></label>
      </div>
      <label>Calories<input name="calories" type="number" min="0" max="5000" step="1" inputmode="numeric"></label>
      <div id="food-form-macros"></div>
      <div id="food-form-error" class="food-form-error hidden"></div>
      <div class="food-form-actions">
        <button type="submit" class="foods-button">Save</button>
        <button type="button" id="food-form-delete" class="foods-button danger">Delete</button>
      </div>
    </form>
  </div>
```

**3d. `MACRO_LABELS`**: append a `form` label to each entry. The existing test anchors on the start of each entry, which stays the same:

```js
    const MACRO_LABELS = {
      protein: { column: 'protein_g', toggle: 'Protein', item: '', total: 'protein', form: 'Protein' },
      fat: { column: 'fat_g', toggle: 'Fat', item: 'fat', total: 'fat', form: 'Fat' },
      fiber: { column: 'fiber_g', toggle: 'Fiber', item: 'fiber', total: 'fiber', form: 'Fiber' },
      added_sugar: { column: 'added_sugar_g', toggle: 'Sugar', item: 'sugar', total: 'added sugar', form: 'Added sugar' },
    };
```

**3e. Tab switching**: replace the existing `// Tab switching` block (the `document.querySelectorAll('.tab').forEach(...)` with its click handler) with:

```js
    // Views and tabs. The food edit form is a view with no tab of its own.
    function showView(name) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(`${name}-view`).classList.add('active');
    }

    function showTab(target) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
      showView(target);
      if (target !== 'foods') {
        editingFood = null;
        tg.BackButton.hide();
      }
      loadTabData(target);
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        showTab(tab.dataset.tab);
        track('miniapp_tab_changed', { tab: tab.dataset.tab });
      });
    });
```

**3f. Foods code**: insert this before `async function loadTabData(tab) {`:

```js
    // Food library (Foods tab). Names are the user's own text: always
    // textContent, never innerHTML.
    let foods = null;
    let selecting = false;
    const selectedFoods = new Set();
    let editingFood = null;

    async function apiSend(method, endpoint, body) {
      const res = await fetch(endpoint, {
        method,
        headers: { 'Authorization': `tg-init-data ${tg.initData}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data };
    }

    // Telegram's own dialogs where the client supports them (Bot API 6.2+), the browser's otherwise.
    function confirmAction(message) {
      return new Promise(resolve => {
        try {
          tg.showConfirm(message, ok => resolve(Boolean(ok)));
        } catch (e) {
          resolve(window.confirm(message));
        }
      });
    }

    function notify(message) {
      try { tg.showAlert(message); } catch (e) { window.alert(message); }
    }

    function plural(n) {
      return n === 1 ? 'food' : 'foods';
    }

    async function loadFoods() {
      const data = await api('/api/foods');
      foods = data.foods;
      renderFoods();
    }

    function renderFoods() {
      const list = document.getElementById('foods-list');
      const query = document.getElementById('foods-search').value.trim().toLowerCase();
      const all = foods || [];
      const selectBtn = document.getElementById('foods-select');
      document.getElementById('foods-count').textContent = all.length ? `${all.length} saved` : '';
      selectBtn.classList.toggle('hidden', all.length === 0);
      selectBtn.textContent = selecting ? 'Done' : 'Select';
      list.innerHTML = '';

      if (all.length === 0) {
        list.innerHTML = '<div class="empty-state">No saved foods yet. Use /foods in the chat to add some.</div>';
        renderDeleteBar();
        return;
      }

      const shown = all.filter(food => !query || food.name.toLowerCase().includes(query));
      if (shown.length === 0) {
        list.innerHTML = '<div class="empty-state">No foods match.</div>';
      }

      for (const food of shown) {
        const row = document.createElement('div');
        row.className = 'food-item food-row';

        if (selecting) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'food-check';
          box.checked = selectedFoods.has(food.id);
          box.tabIndex = -1;
          row.appendChild(box);
        }

        const details = document.createElement('div');
        details.className = 'food-details';
        const name = document.createElement('div');
        name.className = 'food-name';
        name.textContent = food.name;
        const serving = document.createElement('div');
        serving.className = 'food-macros';
        serving.textContent = food.serving;
        details.appendChild(name);
        details.appendChild(serving);

        const calories = document.createElement('div');
        calories.className = 'food-calories';
        calories.textContent = `${food.calories} cal`;

        row.appendChild(details);
        row.appendChild(calories);
        row.addEventListener('click', () => {
          if (selecting) toggleFoodSelection(food.id);
          else openFoodForm(food);
        });
        list.appendChild(row);
      }
      renderDeleteBar();
    }

    function toggleFoodSelection(id) {
      if (selectedFoods.has(id)) selectedFoods.delete(id);
      else selectedFoods.add(id);
      renderFoods();
    }

    function renderDeleteBar() {
      document.getElementById('foods-delete-bar').classList.toggle('hidden', !selecting);
      const btn = document.getElementById('foods-delete');
      btn.textContent = `Delete ${selectedFoods.size}`;
      btn.disabled = selectedFoods.size === 0;
    }

    document.getElementById('foods-search').addEventListener('input', renderFoods);

    document.getElementById('foods-select').addEventListener('click', () => {
      selecting = !selecting;
      selectedFoods.clear();
      renderFoods();
    });

    document.getElementById('foods-delete').addEventListener('click', async () => {
      const ids = Array.from(selectedFoods);
      if (ids.length === 0) return;
      const ok = await confirmAction(`Delete ${ids.length} ${plural(ids.length)}?`);
      if (!ok) return;
      const res = await apiSend('DELETE', '/api/foods', { ids });
      if (!res.ok) {
        notify('Could not delete. Try again.');
        return;
      }
      track('miniapp_foods_deleted', { count: ids.length });
      selecting = false;
      selectedFoods.clear();
      await loadFoods();
    });

    function valueOrBlank(value) {
      return value === null || value === undefined ? '' : value;
    }

    function numberOrNull(value) {
      const text = String(value).trim();
      return text === '' ? null : Number(text);
    }

    function showFormError(message) {
      const box = document.getElementById('food-form-error');
      box.textContent = message ? message.charAt(0).toUpperCase() + message.slice(1) : '';
      box.classList.toggle('hidden', !message);
    }

    function openFoodForm(food) {
      editingFood = food;
      const form = document.getElementById('food-form');
      form.elements.name.value = food.name;
      form.elements.serving.value = food.serving;
      form.elements.serving_amount.value = valueOrBlank(food.serving_amount);
      form.elements.serving_unit.value = food.serving_unit || '';
      form.elements.calories.value = food.calories;

      const macros = document.getElementById('food-form-macros');
      macros.innerHTML = '';
      for (const key of Object.keys(MACRO_LABELS)) {
        const label = document.createElement('label');
        label.textContent = `${MACRO_LABELS[key].form} (g)`;
        const input = document.createElement('input');
        input.name = MACRO_LABELS[key].column;
        input.type = 'number';
        input.min = '0';
        input.max = '500';
        input.step = 'any';
        input.inputMode = 'decimal';
        input.placeholder = 'not on label';
        input.value = valueOrBlank(food[MACRO_LABELS[key].column]);
        label.appendChild(input);
        macros.appendChild(label);
      }

      showFormError('');
      showView('food-edit');
      tg.BackButton.show();
    }

    function closeFoodForm() {
      editingFood = null;
      tg.BackButton.hide();
      showView('foods');
    }

    tg.BackButton.onClick(closeFoodForm);

    document.getElementById('food-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!editingFood) return;
      const form = event.target;
      const body = {
        name: form.elements.name.value,
        serving: form.elements.serving.value,
        serving_amount: numberOrNull(form.elements.serving_amount.value),
        serving_unit: form.elements.serving_unit.value || null,
        calories: numberOrNull(form.elements.calories.value)
      };
      for (const key of Object.keys(MACRO_LABELS)) {
        const column = MACRO_LABELS[key].column;
        body[column] = numberOrNull(form.elements[column].value);
      }
      const res = await apiSend('PATCH', `/api/foods/${editingFood.id}`, body);
      if (!res.ok) {
        showFormError((res.data && res.data.error) || 'Could not save. Try again.');
        return;
      }
      track('miniapp_food_edited');
      await loadFoods();
      closeFoodForm();
    });

    document.getElementById('food-form-delete').addEventListener('click', async () => {
      if (!editingFood) return;
      const ok = await confirmAction(`Delete ${editingFood.name}?`);
      if (!ok) return;
      const res = await apiSend('DELETE', '/api/foods', { ids: [editingFood.id] });
      if (!res.ok) {
        showFormError('Could not delete. Try again.');
        return;
      }
      track('miniapp_foods_deleted', { count: 1 });
      await loadFoods();
      closeFoodForm();
    });
```

**3g. `loadTabData`**: inside its `try`, after the `month` branch:

```js
        if (tab === 'foods') {
          await loadFoods();
        }
```

**3h. Initial load**: replace the final `// Initial load` comment and `loadTabData('today');` with:

```js
    // Initial load. ?tab=foods (the bot's "Open my foods" button) opens the
    // Foods tab, when the server says the library is on.
    async function init() {
      try {
        userData = await getUser();
      } catch (e) {
        console.error('Failed to load user:', e);
      }
      const libraryOn = Boolean(userData && userData.food_library);
      document.getElementById('foods-tab').classList.toggle('hidden', !libraryOn);
      const wanted = new URLSearchParams(window.location.search).get('tab');
      showTab(wanted === 'foods' && libraryOn ? 'foods' : 'today');
    }

    init();
```

- [ ] **Step 4: Run the tests, then check by hand**

Run: `bun test src/web`
Expected: PASS.

Manual check (optional; needs a test bot token in `.env` and `FEATURE_LOCAL_FOOD_DB=true`): `bun run dev`, send `/foods add Quaker Oats 1/2 cup (40 g) 150 kcal 5 g protein` to the test bot, tap Save, then tap "Open my foods". The tab should list the food. Edit its calories, delete it, and confirm both stick after reopening.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/app.html src/web/app-page.test.ts
git commit -m "$(cat <<'EOF'
feat(web): Mini App Foods tab: search, edit, delete one or many (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Docs and help text

**Files:**
- Modify: `src/bot/help.ts`, plus its test if one asserts the full text (`grep -rn HELP_TEXT src --include=*.test.ts`)
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `.env.example`

**Interfaces:**
- Consumes: everything above. Produces documentation only.

- [ ] **Step 1: Help text**

In `src/bot/help.ts`, add the `/foods` line after `/log`, only when the library is on:

```ts
  "/log - Log what you ate, e.g. /log 2 eggs and toast\n" +
  (config.features.localFoodDb ? "/foods - Save foods with their label values, used when you log\n" : "") +
```

Run: `bun test`
Expected: PASS. The flag is off in tests, so the text is unchanged.

- [ ] **Step 2: `.env.example`**

Replace `FEATURE_LOCAL_FOOD_DB=false` with:

```
# Per-user food library: /foods, "Save to my foods", the Mini App Foods tab,
# and label values used when logging
FEATURE_LOCAL_FOOD_DB=false
```

- [ ] **Step 3: `CLAUDE.md`**

Make these edits:

- Commands: change the smoke line to `bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--macros|--foods]   # one live API call to verify a provider; --macros exercises the batch call, --foods the table parser; with POSTHOG_* set, also sends the $ai_generation`.
- Under **Bot Layer**, in the `commands/` line, add `foods` to the list.
- Add a section after **Macros**:

```markdown
**Food library** (`src/library/`, behind `FEATURE_LOCAL_FOOD_DB`): each user's saved foods, label values per serving (`food_library`). `MealEstimator` (`estimator.ts`) is the one entry point for meal estimates (`LogFlow`, the retry job): a meal that `match.ts` matches entirely in code makes no AI call; otherwise up to 15 saved foods go into the AI's user message (never the system prompt) and code applies their label values to the items the AI ties to them. The shared cache is skipped whenever saved foods are involved. Nothing is saved without a preview and a Save tap: `validate.ts` gates every row, `preview.ts` builds the preview. `/foods` (`src/bot/commands/foods.ts`) adds foods by paste, `/foods add`, or "Save to my foods" on a logged meal; the Mini App Foods tab lists, edits and deletes them through `/api/foods`. Spec: `docs/superpowers/specs/2026-11-08-food-library-design.md`.
```

- In "Adding a macro", add: the column in `food_library` (`src/db/schema.sql`, `REAL`), `FOODS_PARSE_PROMPT` (`src/ai/prompt.ts`), and `form` in `MACRO_LABELS`.
- Under **AI Service**, add: `parseFoods` turns a pasted table into rows (call type `import`, no cache).
- Under **Web Server**, in the `api.ts` line, add: `/api/foods` (GET, PATCH, DELETE) are the only routes that change data; same-origin only.
- Under **Configuration** feature flags: `FEATURE_LOCAL_FOOD_DB` (food library).
- Under **Database Tables**, add `- food_library - Saved foods per user, label values per serving` and note that `food_items` has a nullable `saved_food_id`.

- [ ] **Step 4: `README.md` and `CHANGELOG.md`**

README:
- Add a Features bullet: "**Saved foods.** Paste your own table of nutrition label values (or save a logged meal), and logging uses those exact values, with no AI call when a meal is all saved foods. Behind `FEATURE_LOCAL_FOOD_DB`."
- In the Bot Commands table: `| /foods | Save foods with their label values (paste a table, or /foods add) |`.
- In Logging Flow, add one line: "With saved foods, a meal made only of them is logged straight from their labels."

CHANGELOG, under `## [Unreleased]` → `### Added`, at the top:

```markdown
- **Saved foods** (behind `FEATURE_LOCAL_FOOD_DB`). Each user keeps a library of
  foods with their nutrition label values per serving: paste a table into
  `/foods`, type one with `/foods add`, or tap "Save to my foods" on a logged
  meal. Every save shows a preview first. Logging uses the label values (and
  makes no AI call when the whole meal is saved foods); the Mini App's new
  Foods tab searches, edits and deletes them. (#32)
```

- [ ] **Step 5: Run the suite and commit**

Run: `bun test`
Expected: PASS.

```bash
git add src/bot/help.ts .env.example CLAUDE.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: food library in CLAUDE.md, README, changelog and help (#32)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After the last task

- [ ] Run `bun test` once more on the branch tip.
- [ ] Live provider check, one per configured key: `bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --foods` and the same without the flag. This needs `TELEGRAM_BOT_TOKEN` set; the local `GOOGLE_API_KEY` may be stale. Report any provider that couldn't be checked; don't skip it silently.
- [ ] Do not merge or push to `main`. Hand back for review: rollout follows the spec's Rollout section, then #31.

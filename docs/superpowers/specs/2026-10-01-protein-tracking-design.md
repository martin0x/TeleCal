# Protein Tracking — Design

**Date:** 2026-10-01
**Status:** Approved for planning
**Related:** [#10 — Track protein (grams) alongside calories](https://github.com/martin0x/TeleCal/issues/10)

## Problem

TeleCal tracks one number per food item: calories. Users managing body composition
also track protein, and it is the one macro most of them care about. The AI already
knows protein when it estimates calories, so the marginal cost of asking for it is one
extra field per item.

## Goals

1. Every food item carries an estimated protein amount in whole grams.
2. Protein has full parity with calories: a daily goal in `/settings`, remaining/over
   lines in `/today`, goal statistics in `/week` and `/month`, and a progress view in
   the Mini App.
3. Items logged before this ships get protein backfilled by AI, cheaply.
4. Nothing existing breaks during the window between deploy and backfill.

## Non-goals

- Carbohydrates, fat, or any other nutrient. See Decisions.
- Provider batch APIs (OpenAI Batch, Anthropic Message Batches, Gemini Batch Mode).
- Backfilling `estimation_cache`. It self-heals (see Cache).
- Setting the protein goal from the Mini App. Settings stay in the bot.
- Per-item protein confidence.
- Any change to the `/log` state machine or its buttons.

## User-facing behavior

### Shared formats

Two helpers in `src/utils/format.ts` render every item and every total in the bot.
All existing hand-rolled `— N cal` strings in `today.ts`, `edit.ts`, `delete.ts`,
`log-flow.ts` and `format.ts` are replaced by them.

| Helper | Output | Null protein |
|---|---|---|
| `formatItemLine(item)` | `🍳 2 scrambled eggs — 180 cal · 14 g` | `🍳 2 scrambled eggs — 180 cal · ? g` |
| `formatTotals({ calories, protein })` | `335 cal · 28 g protein` | Sums known values, no marker |

Protein is always an integer number of grams. The per-item unit is bare `g`; the total
spells out `g protein`, which disambiguates the item lines above it.

`formatItemsSummary` keeps its blockquote shape and uses `formatItemLine` for each
line and `Total: {formatTotals}` for the bold line.

### Goal direction

Calories are a ceiling; protein is a floor. `/today` says "remaining" for both.
`/week` and `/month` say **Under calorie goal: 5/7 days** and
**Protein goal met: 4/7 days**, where met means at or above the goal.

### `/log` confirmation

Item lines and the bold total gain protein. The confirm button reads
`✅ Log 335 cal · 28 g`. The confirm token already hashes the pending-items JSON, which
now carries `protein_g`, so the token logic is unchanged. The logged reply becomes
`Logged 335 cal · 28 g protein for Fri, Oct 1.`

### `/today`

Item lines use `formatItemLine`. Below them, two mirrored blocks built by one
`formatGoalProgress(label, current, goal, unit)` helper:

```
📊 Calories: 1,450 / 2,000 cal
▓▓▓▓▓▓▓░░░ 73%
✨ 550 cal remaining

💪 Protein: 82 / 120 g
▓▓▓▓▓▓▓░░░ 68%
✨ 38 g remaining
```

With no protein goal the protein block is one line: `💪 Protein: 82 g`. With no
calorie goal the calorie block is `📊 Calories: 1,450 cal`, which matches today's
behavior. "Over goal" and "Goal reached!" wording is kept for both.

### `/week` and `/month`

- Week daily rows: `Mon: ▓▓▓░░ 1,450 cal · 82 g`. The mini bar stays calorie-based.
- Month weekly rows: `Week 1: 9,800 cal · 520 g protein (avg 1,400 cal · 74 g/day)`.
- `📈 Total:` and `📊 Daily avg:` lines carry both units.
- Goal lines as described under Goal direction. Each appears only when that goal is set.

### `/settings`

- New button **Set Protein Goal**. **Set Daily Goal** is renamed **Set Calorie Goal**.
- Keyboard layout: row 1 Change Provider, Set Calorie Goal; row 2 Set Protein Goal,
  Set Reminder; row 3 Set Timezone, Close.
- Settings text gains `Protein Goal: 120 g` or `Protein Goal: Not set`.
- Input flow mirrors the calorie goal: prompt
  `Enter your daily protein goal in grams (e.g., 120), or 'off' to clear it.`
  Accepts a whole number from 10 to 500, or `off`. Confirmation:
  `Daily protein goal set to 120 g. Use /settings to view settings.`

### `/edit`

The editing prompt becomes:

```
Editing: 🍳 2 scrambled eggs — 180 cal · 14 g

• Type a number to set calories (e.g. 200)
• Type a number with g to set protein (e.g. 18g)
• Or describe the food to re-estimate
• Type "cancel" to abort
```

Input parsing, in order:

1. `^\s*(\d+)\s*g\s*$` (case-insensitive), 0–1000 → set `protein_g` only.
2. `^\s*(\d+)\s*$`, 1–9999 → set `calories` only (existing rule).
3. Anything else → re-estimate; update description, calories, protein and emoji from
   the first returned item.

The `Updated:` reply shows the full item line.

### `/delete`

Item lines and totals use the shared helpers, so the "delete all" prompt reads
`Delete all 3 entries for Fri, Oct 1? (335 cal · 28 g protein total)` and the
confirmations follow the same pattern.

### Reminders

The daily reminder adds one protein line under the calorie line. With a goal:
`Protein: 82 / 120 g (68%)`. Without: `Protein: 82 g`. When nothing is logged the
line is omitted.

### `/start`

"Track your calories with AI-powered estimation." becomes "Track your calories and
protein with AI-powered estimation."

### Unknown protein

An item whose `protein_g` is null renders `? g`. This is expected only for rows written
before this ships and not yet backfilled, and for the rare estimate where the model
omits the field. Totals sum what is known, without a marker; the item lines already
show the gap.

## Architecture

### Data model — `src/db/schema.sql`

```sql
-- food_items
protein_g INTEGER            -- null = not yet estimated

-- users
daily_protein_goal INTEGER   -- null = no goal
```

Both columns are added to the `CREATE TABLE` statements so fresh databases and
`createTestDb()` have them from the start.

### Migration — `src/db/migrations.ts` (new)

The repo has no migration mechanism; `schema.sql` is applied with `IF NOT EXISTS`,
which cannot add a column. This file introduces the smallest one that works:

```ts
const COLUMN_MIGRATIONS = [
  { table: "food_items", column: "protein_g", ddl: "INTEGER" },
  { table: "users", column: "daily_protein_goal", ddl: "INTEGER" },
]

export function runMigrations(db: Database): void
```

For each entry, `PRAGMA table_info(<table>)` is read; if the column is absent,
`ALTER TABLE <table> ADD COLUMN <column> <ddl>` runs. Idempotent, no version table,
safe on every boot. `initializeDatabase()` calls it after applying the schema, and
`createTestDb()` calls it too so tests exercise the same path production does.

### Repository — `src/db/repositories/food-logs.ts`

- `FoodItem.protein_g: number | null`.
- `create` writes `protein_g`. `updateItem` accepts `protein_g` (added to
  `allowedColumns`).
- `getTotalCalories(telegramId, date): number` becomes
  `getTotals(telegramId, date): { calories: number; protein: number }`.
- `getDailyTotals(...)` returns `Record<string, { calories: number; protein: number }>`.
- Protein sums use `COALESCE(SUM(protein_g), 0)`; SQL `SUM` skips nulls.
- New, for the backfill: `listDescriptionsMissingProtein(): string[]` (distinct) and
  `setProteinForDescription(description, protein_g): number` (rows updated; matches
  `WHERE protein_g IS NULL AND description = ?`).

Callers of the renamed totals methods: `today.ts`, `stats.ts`, `reminders.ts`,
`web/api.ts`.

### Repository — `src/db/repositories/users.ts`

`User.daily_protein_goal: number | null`; `updateSettings` accepts it.

### AI types — `src/ai/types.ts`

```ts
export interface FoodEstimate {
  description: string
  calories: number
  protein_g: number | null
  emoji?: string
}

export interface ProteinBatchResult {
  /** Aligned with the input array. null where the model gave nothing usable. */
  protein: (number | null)[]
  usage: TokenUsage
}

export interface AIProvider {
  name: string
  estimate(foodDescription: string, context?: string): Promise<ProviderResult>
  estimateProtein(descriptions: string[]): Promise<ProteinBatchResult>
}

export type CallType = "estimate" | "clarify" | "edit" | "retry" | "backfill"
```

### Prompts — `src/ai/prompt.ts` (new)

Anthropic and Gemini carry byte-identical prompt text in two files. The shared rules,
the JSON shape description and the worked example move here; both providers import
them. OpenAI keeps its own shorter `INSTRUCTIONS` because its strict schema does the
shape work.

Every prompt gains the rule: *protein_g: estimated grams of protein for the item, as a
whole number.* The worked example includes `protein_g` on each item.

A second shared prompt, for `estimateProtein`: given a numbered list of food
descriptions, return `{"items":[{"index":1,"protein_g":14}, ...]}` with one entry per
input, using common portion sizes when none is given.

### Providers — `src/ai/providers/*.ts`

- `estimate`: coerce `protein_g` with `Number.isFinite(x) ? Math.round(x) : null`.
  A missing or malformed field degrades to null, never throws.
- OpenAI adds `protein_g: { type: "number" }` to `ESTIMATE_SCHEMA` and to `required`.
- `estimateProtein(descriptions)`: one call per invocation; the caller chunks. Parses
  the index list back into an aligned array; missing or non-finite indices are null.
  OpenAI uses a strict schema for the batch shape; Anthropic and Gemini use the JSON
  prompt with the same fence-stripping they use today.

### Service — `src/ai/service.ts`

- Cache validity: a cached `EstimationResult` is accepted only if every item has a
  finite `protein_g`. Otherwise it is treated as a miss and the fresh result
  overwrites it. Results containing any null `protein_g` are not written to the cache.
- `estimateProtein(descriptions, providerName, opts)`: no cache; records one usage
  row with `callType: "backfill"` using the same `recordSafely` path.
- `ai_usage.call_type` comment in `schema.sql` gains `backfill`.

### Backfill job — `src/jobs/backfill-protein.ts` (new)

```ts
export interface BackfillReport {
  descriptions: number   // distinct descriptions found
  calls: number          // chunks attempted
  itemsFilled: number
  unresolved: number     // descriptions still null after the run
}

export async function runProteinBackfill(
  deps: { foodLogsRepo; aiService },
  opts: { providerName: string; telegramId: number; chatId: number | null; chunkSize?: number },
  onProgress?: (done: number, total: number) => void
): Promise<BackfillReport>
```

1. `listDescriptionsMissingProtein()`.
2. Chunk into groups of 25 (`chunkSize`).
3. For each chunk, sequentially: call `aiService.estimateProtein`, then
   `setProteinForDescription` for each non-null result. Pause 500 ms between chunks.
4. A chunk that throws is logged and skipped; its descriptions count as unresolved.
5. Return the report.

Only null rows are ever written, so the job is idempotent and re-runnable.

### Admin command — `/admin backfill-protein`

Added to `src/bot/commands/admin.ts` and to the `/admin` usage text.

- First reply: `Backfilling protein for {items} items across {descriptions}
  descriptions ({calls} AI calls)…`. If nothing is missing: `Nothing to backfill —
  every item has protein.`
- Runs on the admin's configured provider, falling back to the first configured one.
  Usage rows are attributed to the admin's `telegram_id`.
- Final reply: `Done. Filled {itemsFilled} items. {unresolved} descriptions
  unresolved — run again to retry.` The last sentence is omitted when unresolved is 0.

### Bot layer

- `log-flow.ts`: `confirm: { token, totals: { calories, protein } }`. The `Logged …`
  message uses `formatTotals`.
- `log.ts`: button label from `confirm.totals`.
- `today.ts`, `stats.ts`, `edit.ts`, `delete.ts`, `settings.ts`, `reminders.ts`,
  `index.ts` (`/start`): as described under User-facing behavior.
- `retry-pending.ts`: no logic change; it already inserts through the repository and
  renders through `formatItemsSummary`.
- `scripts/smoke-providers.ts` prints `protein_g` per item. It sits outside
  `tsconfig.json`'s `include`, so `bunx tsc --noEmit` will not flag it; it is updated
  by hand.

### Web API — `src/web/api.ts` (additive only)

Telegram webviews cache the page. A stale `app.html` must keep working against the new
server, so no existing field changes shape or meaning.

| Handler | Added |
|---|---|
| `getUser` | `daily_protein_goal: number \| null` |
| `getToday`, `getDay` | `protein_g` on each item; top-level `protein: number` beside `total` |
| `getStats` | `dailyProtein: Record<date, number>` beside `daily` |

### Mini App — `src/web/views/app.html`

- **Today tab.** The calorie ring is unchanged. Beneath it, a slim horizontal bar
  labelled `82 / 120 g protein`, or `82 g protein` with no goal (bar hidden, text only).
  Item rows show `180 cal · 14 g` in the right-hand column; `? g` when null.
- **Week and month tabs.** A two-way segmented control, **Calories | Protein**, above
  the chart. It selects which series the bars show, which goal draws the dashed line,
  and which number the month calendar cells display. `createWeekChart` and
  `createMonthChart` take a metric parameter instead of being duplicated. Day-log
  lists always show both units.
- Theme colors come from the existing Telegram CSS variables; no new palette.

## Error handling

| Situation | Behavior |
|---|---|
| Model omits or garbles `protein_g` on an estimate | Item stored with null; renders `? g`; result not cached; a later backfill fills it |
| `estimateProtein` returns fewer entries than inputs | Missing indices are null and reported as unresolved |
| A backfill chunk throws | Logged, skipped, counted as unresolved; the run continues |
| `/admin backfill-protein` with no provider configured | Reply: `No AI provider configured.` |
| Migration runs against a database that already has the columns | No-op |
| `confirming` conversation saved before deploy | Items parse with `protein_g` undefined → treated as null; card shows `? g`; logging still works |
| `/edit` input `0g` | Accepted (0 g is a valid value, e.g. black coffee) |
| `/settings` protein goal outside 10–500 | `Please enter a number between 10 and 500, or 'off'.` |

## Testing

Bun's test runner, in-memory SQLite via `createTestDb()`, fakes for providers — the
patterns already in the repo.

**Migration** (`src/db/migrations.test.ts`)
- Pre-feature DDL (no protein columns), seeded with a user and a food item; run
  `runMigrations`; both columns exist, rows intact.
- Run twice; second run is a no-op.

**Repositories**
- `create` and `updateItem` round-trip `protein_g`, including null.
- `getTotals` and `getDailyTotals` skip null protein, return 0 when none known.
- `listDescriptionsMissingProtein` is distinct; `setProteinForDescription` touches
  only null rows with the exact description.
- `users.updateSettings` round-trips `daily_protein_goal`.

**Providers** (`src/ai/providers/*.test.ts`)
- Fake client returns `protein_g` → surfaced rounded.
- Fake returns a string or omits the field → null, no throw.
- OpenAI `ESTIMATE_SCHEMA` lists `protein_g` in `required`.
- `estimateProtein` maps indices back aligned; missing index → null.

**Service** (`src/ai/service.test.ts`)
- Cached result without `protein_g` is a miss and is overwritten.
- Result with a null `protein_g` is not cached.
- `estimateProtein` records one `backfill` usage row and never reads the cache.

**Backfill job** (`src/jobs/backfill-protein.test.ts`)
- Fills only null rows; already-filled rows untouched.
- A throwing chunk is skipped; report counts are exact.
- Chunking: 60 descriptions with `chunkSize: 25` → 3 calls.

**Format** (`src/utils/format.test.ts`)
- `formatItemLine` with and without protein; `formatTotals`; `formatItemsSummary`
  escapes and strikes as before; `formatGoalProgress` with goal, without goal, over
  goal, exactly at goal.

**Commands**
- `/today` with both goals, calorie goal only, no goals.
- `/week` counts "met" as at-or-above; `/month` weekly row format.
- `/edit`: `18g` → protein only; `200` → calories only; `18 G` accepted; text →
  re-estimate updates all fields.
- `/settings`: protein goal validation and `off`.
- `/admin backfill-protein`: both replies, `Nothing to backfill` path.

**Web API** (`src/web/api.test.ts`)
- New fields present; `total`, `daily`, and item shapes unchanged.

**Static**
- `bunx tsc --noEmit` clean.

## Decisions

Recorded so they are not re-litigated.

| Decision | Rejected alternative | Why |
|---|---|---|
| Full parity: protein gets a goal | Display-only v1 | The user wants protein tracked against a target, not just observed. |
| Protein as a peer column | Generic `nutrients` table; all macros now | Flat and greppable, matches the codebase. A nutrients table turns every total into a join. Carbs/fat were not asked for; adding them later repeats this pass, a known cost. |
| Backfill via multi-item synchronous prompts | Provider Batch APIs | The installed Gemini SDK (`@google/generative-ai`) has no batch generation; Gemini is the only working provider. Batch APIs are async (submit, persist job id, poll up to 24 h). One estimate costs ~$0.0002, so halving it saves cents. Packing 25 descriptions per call amortizes the system prompt for comparable savings with no new subsystem. |
| Backfill old rows | Leave null; treat as zero | History should be complete for `/week` and `/month`. Zero understates. |
| Nullable `protein_g` | `NOT NULL DEFAULT 0` | 0 g is a real value (black coffee). Null is the only honest "unknown". |
| `PRAGMA table_info`-guarded `ALTER` list | Version table; numbered migration files | Two columns. Idempotent and boot-safe. Smallest mechanism that works; can grow into a version table later if needed. |
| Cache validated by shape on read | Wipe `estimation_cache`; version prefix on the key | Self-heals one description at a time with no deploy step and no lost cache for descriptions that get re-estimated anyway. |
| Additive-only web API | Reshape `total` and `daily` | Telegram webviews cache `app.html`; a stale page must not break. |
| Calories/Protein toggle on week and month | Dual-axis chart; two charts | Two y-axes mislead the eye; two charts double the vertical space. One metric per chart, switched by the user. |
| "Under goal" for calories, "goal met" for protein | Same wording for both | Calories are a ceiling, protein a floor. Same wording would make one of them read backwards. |
| `18g` syntax in `/edit` | A separate sub-mode or button | One regex, no new state. |
| Backfill matches exact `description` | Normalized match | Exact match is what the AI actually estimated; normalizing risks merging different portions. Distinct descriptions are few. |

## Known limitations

- Backfilled protein is a retroactive estimate from the item description alone,
  without the clarification context the original log may have had.
- Backfill description matching is exact and case-sensitive; `Chicken Breast` and
  `chicken breast` cost two entries in a chunk.
- Between deploy and the admin running `/admin backfill-protein`, `/week` and `/month`
  protein totals understate, and item lines show `? g`.
- The Mini App's protein view depends on the user reopening the app after deploy if
  Telegram has cached the old page. The API stays compatible so the old page does not
  break; it simply does not show protein.
- OpenAI and Anthropic `estimateProtein` paths are covered by fakes only, for the same
  reason as their `estimate` paths (no credits, no key).

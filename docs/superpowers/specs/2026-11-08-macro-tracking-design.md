# Macro Tracking (Fat, Fiber, Added Sugar) — Design

**Date:** 2026-11-08
**Status:** Design approved in chat; written spec awaiting review
**Related:** [#10 — Track protein (grams) alongside calories](https://github.com/martin0x/TeleCal/issues/10), whose design this extends

## Problem

TeleCal tracks calories and protein per food item. Users also want fat, fiber and
added sugar. Not every user cares about every macro, and chat replies are narrow
on phones: four macros on every item line is a lot of text for someone who only
watches protein. So each user picks which macros they see.

The AI already knows these values when it estimates calories, so asking for them
costs a few extra fields per item.

## Goals

1. Every food item carries estimated fat, fiber and added sugar in whole grams,
   beside protein.
2. Each user chooses which of protein, fat, fiber and added sugar appear in their
   replies and in the Mini App. Calories always appear.
3. With the default selection (protein only), every log, `/today`, `/week`,
   `/month`, `/edit`, `/delete` and reminder reply is unchanged, byte for byte.
4. Items logged before this ships get the new macros backfilled by AI, in the
   same run as the protein backfill still owed from #10.
5. Nothing existing breaks between deploy and backfill.

## Non-goals

- Carbohydrates, saturated fat, sodium or any other nutrient. See Decisions.
- Goals for fat, fiber or added sugar. Protein keeps its goal.
- Changing macro toggles from the Mini App. Settings stay in the bot.
- New PostHog events (e.g. for toggling a macro).
- Fixing #9: in groups, `/settings` buttons act for whoever taps them. The
  Macros toggles inherit this.
- Passing calories into the backfill prompt to tell portions apart.
- Provider batch APIs; backfilling `estimation_cache` (it self-heals, see Cache).

## User-facing behavior

### Which macros a user sees

Each user has a set of tracked macros, stored as `users.tracked_macros`. Default
for existing and new users: protein only. A user can switch any of the four on or
off, including protein. Order on screen is always the registry order (protein,
fat, fiber, added sugar), whatever order they were switched on in.

The AI estimates all four macros on every log, whatever the user's selection, so
switching a macro on later shows it for earlier meals too.

Switching protein off removes it from every reply and from the Mini App. The
protein goal stays saved and comes back with protein.

In groups, each reply uses the tracked macros of the user it is about (the one who
logged, asked for `/today`, and so on).

### Shared formats

| Tracked | Item line (`formatItemLine`) |
|---|---|
| protein (default) | `🍗 Chicken adobo (2 pcs) — 420 cal · 38 g` |
| all four | `🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 24 g fat · 1 g fiber · 2 g sugar` |
| added sugar only | `🍗 Chicken adobo (2 pcs) — 420 cal · 2 g sugar` |
| none | `🍗 Chicken adobo (2 pcs) — 420 cal` |

| Tracked | Totals (`formatTotals`) |
|---|---|
| protein (default) | `625 cal · 42 g protein` |
| all four | `625 cal · 42 g protein · 24 g fat · 2 g fiber · 2 g added sugar` |
| none | `625 cal` |

- Protein keeps its bare `g` on item lines, as now. The other macros carry a
  label. Item lines say `sugar` to save width; totals spell out `added sugar`.
- An unknown value renders `? g` for protein (as now) and `? g fat`, `? g fiber`,
  `? g sugar` for the others. Totals sum what is known, without a marker.
- All values are whole grams.

### `/log` confirmation

- The item lines and the bold total use the formats above.
- The confirm button keeps calories and protein only: `✅ Log 625 cal · 42 g`, or
  `✅ Log 625 cal` with protein off. A longer label does not fit.
- The typed-yes reply: `Logged 625 cal · 42 g protein · 2 g added sugar for Sat, Oct 31.`

### `/today`

Item lines use `formatItemLine`. The calorie block is unchanged. The protein block
is unchanged and appears only when protein is tracked. Each other tracked macro
gets one line, with no emoji, grouped under a blank line:

```
📊 Calories: 1,050 / 2,000 cal
█████░░░░░ 53%
✨ 950 cal remaining

💪 Protein: 50 / 120 g
████░░░░░░ 42%
✨ 70 g remaining

Fat: 36 g
Fiber: 1 g
Added sugar: 2 g
```

With protein off, the extra lines follow the calorie block directly, after one
blank line.

### `/week` and `/month`

- Week day rows keep calories and protein only:
  `Mon: ███░░ 1,450 cal · 82 g`, or `Mon: ███░░ 1,450 cal` with protein off.
- Month weekly rows keep calories and protein only:
  `Week 1: 9,800 cal · 520 g protein (avg 1,400 cal · 74 g/day)`, or
  `Week 1: 9,800 cal (avg 1,400 cal/day)` with protein off.
- `📈 Total:` and `📊 Daily avg:` use `formatTotals` with every tracked macro.
- `🎯 Under calorie goal` is unchanged. `💪 Protein goal met` appears only when
  protein is tracked and a protein goal is set.

### `/edit`

The editing prompt for a user tracking protein and added sugar:

```
Editing: 🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 2 g sugar

What would you like to change?
• Type a number to set calories (e.g. 200 or 200 cal)
• Type a number with g to set protein (e.g. 18g)
• Add the macro's name to set another (e.g. 5g sugar)
• Or describe the food to re-estimate
• Type "cancel" to abort
```

- The protein line appears only when protein is tracked.
- The "Add the macro's name" line appears only when a macro other than protein is
  tracked. Its example uses the first such macro in registry order: `5g fat`,
  `5g fiber` or `5g sugar`.

Input parsing, in order:

1. `^\s*(\d+)\s*g\s*$` (case-insensitive) → protein, as now.
2. `^\s*(\d+)\s*g\s+(<keyword>)\s*$` (case-insensitive), where the keywords come
   from the registry: `protein`, `fat`, `fiber`, `fibre`, `sugar`, `added sugar`
   → that macro.
3. The existing calories rule.
4. Anything else → re-estimate; update description, calories, emoji and all four
   macros from the first returned item. `200g chicken` still lands here.

A macro value must be 0–1000: `Fat must be between 0 and 1000 g.`

Any macro can be edited, tracked or not. The `Updated:` reply shows the item line
with the user's tracked macros plus the one just edited.

### `/delete`

Item lists, the single-item prompt, the "delete all" prompt and the confirmations
use the shared formats with the user's tracked macros.

### Reminders

After the protein line (shown only when protein is tracked), one line per other
tracked macro, e.g. `Fat: 38 g`. The no-logs reminder is unchanged.

### `/settings`

The settings text gains a line after `Protein Goal`:
`Macros: Protein, Added sugar`, or `Macros: None`.

Main keyboard:

```
[Change Provider]   [Set Calorie Goal]
[Set Protein Goal]  [Macros]
[Set Reminder]      [Set Timezone]
[Meal Text Sharing] [Close]
```

**Macros** (`settings:macros`) edits the message to:

```
⚙️ Macros

Calories always show. Pick what else shows beside them. Every meal is estimated for all four, so switching one on shows it for earlier meals too.

[Protein ✓] [Fat]
[Fiber]     [Added sugar ✓]
[← Back]
```

- A macro button (`settings:macro:<key>`) toggles that macro, saves, redraws this
  screen and answers with a toast: `Fiber on` or `Fiber off`. The ✓ suffix
  matches the provider picker.
- `← Back` returns to the main settings view (the existing `settings:back`).

### `/start` and the access-approval message

`HELP_TEXT` gains a sentence:
`Track your calories and protein with AI-powered estimation. Switch on fat, fiber and added sugar in /settings → Macros.`

### Mini App

New elements are text only, no emoji.

- **Today tab.** The calorie ring is unchanged. The protein bar shows only when
  protein is tracked. Below it, one line in the hint color lists the other tracked
  macros from the day's `macros` totals, with totals labels:
  `36 g fat · 1 g fiber · 2 g added sugar`. Hidden when there are none.
- **Week and month tabs.** The segmented control is built from the user's tracked
  macros: `Calories | Protein | Fat | Fiber | Sugar`, showing only the tracked
  ones. It is hidden when no macro is tracked. The selected metric is shared by
  both tabs, as now, and falls back to Calories if it is not tracked. The dashed
  goal line is drawn for calories and protein only.
- **Food rows.** The right-hand column is `420 cal · 38 g` when protein is tracked,
  `420 cal` when not. The other tracked macros go on a second line under the food
  name, in the hint color, with item labels: `24 g fat · 1 g fiber · 2 g sugar`.
  Unknown values show `?`, as protein does.
- **Day header.** `Today's Log • 625 cal · 42 g protein · 2 g added sugar`, with
  the tracked macros.
- A page Telegram has cached from before this ships ignores the new API fields and
  shows calories and protein, as now.

### Landing page

Two strings in `src/web/views/landing.html` change. Everything else on the page
stays true with the protein-only default, including the screenshots, which are
not re-rendered.

- The "Calories and protein" feature card text becomes: `Every item gets both, so
  you can hit a protein target as well as a calorie limit. Fat, fiber and added
  sugar can be switched on too.`
- The pricing list item `Calories and protein` becomes
  `Calories, protein, fat, fiber and added sugar`.

## Architecture

### Registry — `src/macros.ts` (new)

The one place that names a macro. Calories are not in it. Each entry also has a
`rule`, the prompt line listed under Prompt rules below.

```ts
export const MACROS = [
  { key: "protein", column: "protein_g", name: "Protein", itemLabel: "", totalLabel: "protein",
    keywords: ["protein"] },
  { key: "fat", column: "fat_g", name: "Fat", itemLabel: "fat", totalLabel: "fat",
    keywords: ["fat"] },
  { key: "fiber", column: "fiber_g", name: "Fiber", itemLabel: "fiber", totalLabel: "fiber",
    keywords: ["fiber", "fibre"] },
  { key: "added_sugar", column: "added_sugar_g", name: "Added sugar", itemLabel: "sugar",
    totalLabel: "added sugar", keywords: ["sugar", "added sugar"] },
] as const

export type MacroKey = (typeof MACROS)[number]["key"]
export type MacroColumn = (typeof MACROS)[number]["column"]
export type Totals = { calories: number } & Record<MacroKey, number>

export const DEFAULT_MACROS: readonly MacroKey[] = ["protein"]

/** Registry order; unknown keys dropped; null or undefined → DEFAULT_MACROS; "" → []. */
export function parseTrackedMacros(raw: string | null | undefined): MacroKey[]
export function serializeTrackedMacros(keys: readonly MacroKey[]): string
export function macroByKeyword(word: string): (typeof MACROS)[number] | undefined
```

Prompt rules (the `rule` field):

- protein: `- protein_g: estimated grams of protein for the item, as a whole number` (the current `PROTEIN_RULE`)
- fat: `- fat_g: estimated grams of total fat for the item, as a whole number`
- fiber: `- fiber_g: estimated grams of dietary fiber for the item, as a whole number`
- added sugar: `- added_sugar_g: estimated grams of added sugar for the item, as a whole number. Count sugar, syrups, honey and other sweeteners added in processing or cooking, including in sauces, drinks and desserts. Sugar that occurs naturally in whole fruit, vegetables and plain milk counts as 0`

### Data model — `src/db/schema.sql`

```sql
-- food_items
fat_g INTEGER,                -- whole grams; null = not yet estimated
fiber_g INTEGER,              -- whole grams; null = not yet estimated
added_sugar_g INTEGER,        -- whole grams; null = not yet estimated

-- users
tracked_macros TEXT DEFAULT 'protein',  -- comma list of macro keys; '' = none
```

Added to the `CREATE TABLE` statements and, as four entries, to
`COLUMN_MIGRATIONS`. SQLite's `ADD COLUMN ... DEFAULT 'protein'` gives every
existing user `'protein'`.

### Repository — `src/db/repositories/food-logs.ts`

- `FoodItem` carries `Partial<Record<MacroColumn, number | null>>` in place of the
  lone `protein_g`.
- `DayTotals` becomes `Totals`.
- `create`, `updateItem`, `getTotals` and `getDailyTotals` loop over the registry.
  Totals SQL is `COALESCE(SUM(fi.<column>), 0) AS <key>` per macro, built from
  registry constants, never from input.
- Backfill methods, renamed:
  - `listDescriptionsMissingMacros(): string[]`: distinct descriptions of items
    with any macro null.
  - `countItemsMissingMacros(): number`.
  - `fillMissingMacros(description, values: Partial<Record<MacroColumn, number>>): number`:
    `SET <column> = COALESCE(<column>, ?)` for each given value, `WHERE
    description = ?` and any macro is null. Returns rows changed. Never
    overwrites a value, so `/edit` corrections survive.

### Repository — `src/db/repositories/users.ts`

`User.tracked_macros: MacroKey[]`, parsed with `parseTrackedMacros` in
`rowToUser`. `updateSettings` accepts `tracked_macros: MacroKey[]` and stores
`serializeTrackedMacros(...)`.

### AI types — `src/ai/types.ts`

```ts
export type FoodEstimate = {
  description: string
  calories: number
  emoji?: string
} & Record<MacroColumn, number | null>

export interface MacroBatchResult {
  /** Aligned with the input array. Each value null where the model gave nothing usable. */
  values: Record<MacroColumn, number | null>[]
  usage: TokenUsage
  trace?: AITrace
}

export interface AIProvider {
  name: string
  estimate(foodDescription: string, context?: string): Promise<ProviderResult>
  /** All four macros for many descriptions in one call; the caller chunks. */
  estimateMacros(descriptions: string[]): Promise<MacroBatchResult>
}
```

`ProteinBatchResult` and `estimateProtein` go away.

### Prompts — `src/ai/prompt.ts`

- `PROTEIN_RULE` becomes `MACRO_RULES`, the registry's rule lines joined by
  newlines. OpenAI's `INSTRUCTIONS` and `ESTIMATE_JSON_PROMPT` both use it.
- `ESTIMATE_JSON_PROMPT`: the first line says the model estimates "calories,
  protein, fat, fiber and added sugar". The item shape lists every column. The
  worked example gains values:
  `{"description":"Chicken sandwich","calories":450,"protein_g":28,"fat_g":18,"fiber_g":2,"added_sugar_g":4,"emoji":"🥪"}`
  and
  `{"description":"French fries (medium)","calories":365,"protein_g":4,"fat_g":17,"fiber_g":4,"added_sugar_g":0,"emoji":"🍟"}`.
- `PROTEIN_BATCH_PROMPT` becomes `MACRO_BATCH_PROMPT`. Each reply entry is
  `{"index":1,"protein_g":14,"fat_g":10,"fiber_g":0,"added_sugar_g":0}`, and the
  rules include the added-sugar definition.
- `formatProteinBatchInput` becomes `formatBatchInput`, unchanged in behavior.

### Parsing — `src/ai/parse.ts`

- `coerceProtein` becomes `coerceGrams`: a finite number or numeric string,
  rounded, clamped at 0. Above 1000 → null. Closes a #10 review follow-up.
- `normalizeItems` coerces every registry column.
- `alignProteinBatch` becomes `alignMacroBatch`: one record per input, every
  column coerced, missing or out-of-range indices all-null.

### Providers — `src/ai/providers/*.ts`

- `estimate`: unchanged apart from `normalizeItems` covering the new columns.
- OpenAI `ESTIMATE_SCHEMA` item properties and `required` gain every registry
  column, generated from the registry. The batch schema likewise.
- `estimateMacros(descriptions)` replaces `estimateProtein`: one call, same
  prompt-and-parse shape per provider as today.

### Service — `src/ai/service.ts`

- Cache validity: `isCurrentShape` accepts a cached result only if `items` is an
  array and every item has a finite value for every registry column. Old entries
  become misses and are overwritten. Results with any null macro are not cached.
- `estimateMacros(descriptions, providerName, opts)` replaces `estimateProtein`:
  no cache, one usage row with `callType: "backfill"`.

### Backfill — `src/jobs/backfill-macros.ts` (renamed from `backfill-protein.ts`)

`runMacroBackfill` keeps `runProteinBackfill`'s shape: distinct descriptions with
any macro missing, chunks of 25, a 500 ms pause, a throwing chunk logged and
skipped. For each description, the non-null values go to `fillMissingMacros`.
`BackfillReport` keeps its fields. `unresolved` counts descriptions in a failed
chunk or with any value still null in the reply.

### Admin — `/admin backfill-macros`

Replaces `/admin backfill-protein`, which was never run in production, so it gets
no alias. It still runs in the background and refuses a second concurrent run.

- Start: `Backfilling macros for {items} items across {descriptions} descriptions ({calls} AI calls)…`
- Nothing to do: `Nothing to backfill — every item has all its macros.`
- Done: `Done. Filled {itemsFilled} items. {unresolved} descriptions unresolved — run again to retry.`
  The last sentence is omitted when unresolved is 0.
- Failure: `Backfill failed: {message}. Nothing was lost — run /admin backfill-macros again to retry.`
- `/admin` usage text lists `/admin backfill-macros`.

### Formatting — `src/utils/format.ts`

```ts
sumTotals(items): Totals                                 // every macro; unknown counts as 0
formatItemLine(item, macros: readonly MacroKey[]): string
formatTotals(totals: Totals, macros: readonly MacroKey[]): string
formatItemsSummary(items, macros: readonly MacroKey[], opts?: { struck?: boolean }): string
```

- `macros` is required, never defaulted, so no call site can silently ignore a
  user's choice.
- `formatGoalProgress` takes an optional emoji.
- The `toLocaleString("en-US")` helper is exported and reused in `stats.ts` and
  `reminders.ts` instead of their copies.

### Bot layer

- `log-flow.ts`: `LogFlow` takes `UsersRepository` as a new constructor argument
  and reads the user's tracked macros to format the confirmation, the result
  edits and the typed-yes reply. `confirm` becomes `{ token, totals: Totals,
  macros: MacroKey[] }`.
- `log.ts`: `buildLogConfirmKeyboard` adds the protein part only when `macros`
  includes protein.
- `today.ts`, `stats.ts`, `edit.ts`, `reminders.ts`, `retry-pending.ts`: pass the
  user's tracked macros to the formatters. All already load the user.
- `delete.ts`: `createDeleteMessageHandler` and `createDeleteCallbackHandler` take
  `UsersRepository`, as `createDeleteCommand` does.
- `settings.ts`: the Macros screen, the keyboard change and the settings text line.
- `help.ts`: the new sentence.
- `bot/index.ts`: wiring for the new constructor and handler arguments.

### Web API — `src/web/api.ts` (additive only)

| Handler | Added |
|---|---|
| `getUser` | `tracked_macros: MacroKey[]`, in registry order |
| `getToday`, `getDay` | `fat_g`, `fiber_g`, `added_sugar_g` on each item; `macros: Record<MacroKey, number>` beside `total` and `protein` |
| `getStats` | `dailyMacros: Record<MacroKey, Record<date, number>>`, zero-filled, beside `daily` and `dailyProtein` |

`protein_g`, `protein` and `dailyProtein` stay for cached pages.

### Mini App — `src/web/views/app.html`

- A `MACRO_LABELS` map in the page script holds each key's toggle label (`Sugar`
  for added sugar), item label and totals label. The page is static HTML and
  cannot import `src/macros.ts`, so a test checks that the page names every
  registry key.
- `tracked_macros` missing from `/api/user` is read as `['protein']`.
- Segmented controls are rendered by script from the tracked list, in place of
  the two static buttons.
- `METRICS` gains a series per macro from `dailyMacros`. Only calories and protein
  have a goal.
- `miniapp_metric_changed` sends the new keys as values.

### Scripts

- `scripts/smoke-providers.ts`: `--protein` becomes `--macros` and prints all four
  values per item. It sits outside `tsconfig.json`'s `include`, so it is updated
  and run by hand.
- `scripts/telegram-mock/render.ts`: passes `DEFAULT_MACROS` to the formatters, so
  its output is unchanged. Also outside `include`.

### Docs

- README: intro, commands table (`/settings` mentions macros; `/admin` says
  backfill macros) and the Privacy note on the backfill.
- CHANGELOG: an entry under Unreleased.
- CLAUDE.md: the smoke command flag, the backfill job name, the `users` and
  `food_items` columns.

## Error handling

| Situation | Behavior |
|---|---|
| Model omits or garbles a macro on an estimate | Stored null; renders `? g fat` to users tracking fat; result not cached; the backfill fills it later |
| Model returns a macro above 1000 g | Treated as garbled: null |
| Batch reply lacks some values for a line | The values present are filled; the description counts as unresolved |
| A backfill chunk throws | Logged, skipped, counted unresolved; the run continues |
| `/admin backfill-macros` with no provider configured | `No AI provider configured.` |
| `tracked_macros` holds an unknown key | Ignored |
| `tracked_macros` is null | Read as protein only |
| `confirming` conversation saved before deploy | New fields read as null; logging still works |
| `/edit 24g fat` when fat is not tracked | Saved; the `Updated:` line shows it |
| `/edit` macro value outside 0–1000 | `{Name} must be between 0 and 1000 g.` |
| Migration runs against a database that already has the columns | No-op |

## Testing

Bun's test runner, in-memory SQLite via `createTestDb()`, fake provider clients.

**Refactor first.** The first change moves protein onto the registry with no
behavior change. Test call sites may gain the new `macros` argument, but no
expected value may change. That is the proof that protein-only output is
identical.

**Registry** (`src/macros.test.ts`)
- `parseTrackedMacros`: registry order, unknown keys dropped, `""` → none, null → protein.
- `serializeTrackedMacros` round-trips.
- `macroByKeyword` finds `fibre` and `added sugar`.

**Migration and repositories**
- The migration adds the four columns to a pre-feature database; existing users
  read back as `['protein']`; a second run is a no-op.
- `create`, `updateItem`, `getTotals` and `getDailyTotals` cover every macro,
  including null.
- `fillMissingMacros` fills only null cells and leaves edited values alone;
  `listDescriptionsMissingMacros` is distinct.
- `users.updateSettings` round-trips `tracked_macros`.
- `log-flow.test.ts` and `users.test.ts` hand-copy DDL; they move to
  `createTestDb()` so the new columns cannot drift (a #10 follow-up).

**AI**
- Prompts contain every rule; OpenAI's schemas require every column.
- `coerceGrams`: strings, NaN, negatives, values above 1000.
- `normalizeItems` and `alignMacroBatch` per column.
- `isCurrentShape` rejects an item missing any macro, and a non-array `items`.
- `estimateMacros` records one `backfill` row and never reads the cache.

**Backfill** (`src/jobs/backfill-macros.test.ts`): fills only null cells; partial
replies count as unresolved; a throwing chunk is skipped; 60 descriptions in
chunks of 25 make 3 calls.

**Formatting**: every formatter for protein only, all four, protein off and
none; `? g fat` for unknown values.

**Commands**
- `/today`, `/week`, `/month` with extra macros on, protein off and the default.
- `/edit` parsing: `18g`, `18g protein`, `3g sugar`, `3g added sugar`,
  `5g fibre`, `200g chicken` (re-estimates), out of range.
- `/edit` prompt hint lines.
- `/settings`: the Macros screen, toggling, the keyboard layout and the text line.
- `/delete` with extra macros.
- Reminders with extra macros.
- `/admin backfill-macros`: all replies.
- `LogFlow`: the card, the button label and the typed-yes reply follow the
  user's macros.

**Web API**: new fields present; `total`, `protein`, `daily`, `dailyProtein` and
item shapes unchanged.

**Mini App**: a test that `app.html` names every registry key; a parse check of
the page script, as for #10.

**Static**: `bunx tsc --noEmit` clean.

**Live, before merging**
- `bun run scripts/smoke-providers.ts gemini` and `bun run scripts/smoke-providers.ts gemini --macros`.
- The test bot: a log with all four on, the Macros screen, the Mini App.

## Rollout

1. Implement on `feat/macros`, tracked in a GitHub issue opened once this spec is
   approved.
2. Check on the test bot, then merge fast-forward to `main`. Pushing `main`
   deploys to Railway.
3. Run `/admin backfill-macros` once in production. It also fills the protein
   still missing from #10.

Step 2's Mini App check and step 3's backfill also tick #10's two open
checkboxes.

## Decisions

Recorded so they are not re-litigated.

| Decision | Rejected alternative | Why |
|---|---|---|
| Each user picks their macros | Everyone sees all four; new macros only in totals | The user's choice. Keeps replies short for people who only track protein. |
| Default: protein only | All four on | Nobody's replies change on deploy. The new macros are opt-in. |
| No goals for fat, fiber, added sugar | Goals for all three; fiber and sugar only | The user's choice. Smallest scope; a fixed direction for fat would read backwards on some diets. |
| A registry in code over flat columns | Copy the protein pattern three times; a `food_item_nutrients` table | Toggles mean every formatter takes a list of macros anyway. Copying is about three times protein's 21 commits. A nutrients table makes every total a join or pivot (rejected for protein for that reason). |
| `tracked_macros` as one comma-list column | A boolean column per macro | A future macro needs no new toggle column; display order comes from the registry. |
| AI estimates all four on every log | Only the tracked ones | One call either way. History is complete when a macro is switched on. The cache stays shared across users. |
| Protein keeps bare `g`; others labelled; `sugar` on items, `added sugar` in totals | Label everything; same label everywhere | Keeps the default output identical. Saves width where it is tight. |
| Stats rows and the confirm button keep calories and protein | Every tracked macro | Four macros would wrap each row onto two or three lines and do not fit a button. Total and daily average carry them; the Mini App shows per-day trends. |
| No emoji for the new macros | 🥑 🥦 🍬 | The user's choice. |
| `/admin backfill-macros`, filling null cells only | Keep `backfill-protein` beside a new command | One run covers everything still missing, including protein. Filling only nulls makes it re-runnable and never undoes an `/edit`. |
| `/edit` macro edits need a registry word after `Ng` | Any word after `Ng` | `200g chicken` must still re-estimate. |
| Mini App labels hardcoded, guarded by a test | Server injects the registry into the page | Static page, four entries; the test catches drift. |
| Formatters require `macros` | Default to protein | A forgotten call site fails to compile instead of hiding a user's macros. |
| Carbs left out | Add them now | Not asked for. The registry makes them one entry plus a backfill run. |

## Known limitations

- Backfilled values are estimated from the item description alone, without the
  clarification context the original log may have had.
- Until `/admin backfill-macros` runs, a user who switches a macro on sees `?` on
  items logged before the deploy, and their totals understate.
- Added sugar is the least reliable of the four estimates; recipes vary (adobo
  with or without sugar).
- A Mini App page cached by Telegram from before the deploy shows protein whatever
  the toggles, until Telegram reloads it.
- In groups, anyone can tap another user's `/settings` buttons (#9), including the
  Macros toggles.
- Backfill matching is on the exact description, as for protein.
- OpenAI and Anthropic paths are covered by fakes only (no credits or key), as
  for protein.

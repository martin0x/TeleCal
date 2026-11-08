# Food Library — Design

**Date:** 2026-11-08
**Status:** Approved for planning
**Related:** [#32 — Per-user food library: saved label values used when logging](https://github.com/martin0x/TeleCal/issues/32); post-deploy stress test [#31](https://github.com/martin0x/TeleCal/issues/31)

## Problem

One user keeps her logging accurate by recording, in a Google Doc, the nutrition
label values of the foods she eats often. TeleCal estimates every meal with AI, so
the same packaged food can come out differently from one log to the next, and
never exactly matches its label.

The shared `estimation_cache` does not help. It matches only an exact repeat of
the whole message ("2 eggs and toast" misses "toast and 2 eggs"), and it stores
AI guesses, not label values.

## Goals

1. Each user keeps a library of saved foods with label values per serving.
2. Foods are added by pasting a table, by typing one food, or from a logged meal.
   Every add shows a preview and saves only when the user taps Save.
3. Browsing, searching, editing and deleting (one or many) happen in the Mini App,
   and stay comfortable with hundreds of foods.
4. When a logged meal includes a saved food, its numbers are the label values
   times the servings eaten, calculated by code, not by the AI.
5. A meal made only of saved foods, in quantities code can scale, is logged with
   no AI call.
6. With `FEATURE_LOCAL_FOOD_DB` off, or for a user with no saved foods, every
   reply and every AI call is unchanged.

## Non-goals

- Syncing with or importing from Google Docs. The user pastes.
- Aliases or synonyms for saved foods ("oatmeal" finding "Quaker Oats").
- Editing or deleting foods in chat. That is the Mini App's job.
- Adding foods from the Mini App. Adding stays in chat in v1.
- `/edit` using the library. Its re-estimates stay plain AI.
- Sorting the library by recently used.
- Sharing libraries between users, or a global food database.
- Updating past logs when a saved food is edited or deleted.
- A "Save to my foods" button on entries logged by the retry job.
- A size cap on the library.
- Fixing #9.

## User-facing behavior

### A saved food

| Field | Example | Notes |
|---|---|---|
| Name | Quaker Oats | Unique per user, ignoring case and punctuation |
| Serving | 1/2 cup (40 g) | The label's own wording |
| Serving amount and unit | 40, g | Only when the label gives one. Units are `g` or `ml` |
| Calories | 150 | Per serving, required |
| Protein, fat, fiber, added sugar | 5, 3, 4, blank | Per serving, decimals allowed. Blank means not on the label |

All four macros are stored whatever the user tracks, so switching a macro on later
already has data. Replies show only the user's tracked macros, as everywhere else.

### `/foods`

Private chat only. In a group it replies "Open me in a private chat to manage your
foods." With the flag off it replies that the feature is not available.

```
You have 143 foods saved.
[Add foods]  [Open my foods]
```

"Open my foods" is a `web_app` button that opens the Mini App on the Foods tab. With no saved foods the first line reads "No saved foods yet."

### Adding: a pasted table or one food

"Add foods" replies "Paste one food or a whole table. Values per serving." The
user's next text message is the paste. `/foods add <text>` skips that prompt and
goes straight to the preview, like `/log <food>`. Sending any command while the
bot is waiting for a paste stops waiting.

One AI call turns the text into rows. Then:

```
Found 3 foods (per serving):
1. Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber
2. Nestle Fresh Milk · 1 cup (250 ml) · 160 cal · 8g protein · 9g fat
3. Skyflakes · 1 pack (25 g) · 110 cal · 2g protein (replaces your saved one)
Couldn't read: "lunch adobo" (no calories)
[Save 3]  [Cancel]
```

Preview lines show every value the label has, not only tracked macros, so the user
can check the whole row against the label. Blank values are left off the line.
Lines use the bot's existing units ("cal", "g").

Rules:

- **Per serving.** When the label shows both per serving and per 100 g, the parser
  takes per serving. When it shows only per 100 g, the serving is "100 g".
- **Duplicates.** A row whose name the user already has is marked "replaces your
  saved one". Saving replaces it.
- **Unreadable rows.** Rows without calories, or with values outside 0–5000 kcal or
  0–500 g per macro per serving, are listed under "Couldn't read" with the reason
  and are not saved.
- **No serving.** A row without a serving is saved as "1 serving" with no amount,
  and its preview line says "no serving size".
- **No preview edits.** To fix a row, the user saves and then edits it in the Mini
  App, or cancels and pastes again.
- **Long pastes.** Telegram splits a message over 4096 characters into several.
  Each message gets its own preview and its own Save. A message within 10
  seconds of a paste is taken as more of it.
- **Long previews.** A preview that would not fit in one Telegram message lists
  as many rows as fit, then "…and 12 more". Save still saves every row.
- **Saving.** "Saved 3 foods (1 replaced). You have 145 foods." with an "Open my
  foods" button in private chats. Telegram refuses `web_app` buttons in groups,
  so a save from a log in a group gets the text only.

### Save from a log

When the flag is on, the "Logged" message gets a "Save to my foods" button,
unless every logged item came from the library. This covers both the Log button
and a typed "yes". Only the user who logged can press it.

```
Save to your foods? Values are per serving, as logged.
1. Chicken adobo (1 cup) · 350 cal · 30g protein
2. Garlic rice (1 cup) · 300 cal · 5g protein (replaces your saved one)
[1 ✓] [2 ✓]
[Save 2]  [Cancel]
```

- Each item becomes a food named after its description, with serving "as logged"
  and no amount. Later it scales only by servings, not by weight.
- The number buttons switch items on and off, like `/settings` → Macros. Save
  shows how many are on.
- Items that came from the library are left out while their saved food still
  exists; once it is deleted, they are offered again. If every item is left out,
  the press answers "These are already in your foods."

### Logging with the library

This applies to `/log`, `/log <food>` and the retry job. Order:

1. **Code only.** If every part of the message matches a saved food and every
   quantity can be scaled, the items are built from the labels. No AI call.
2. **AI with saved foods.** Otherwise, if any saved foods look relevant, the AI
   gets the message plus up to 15 of them, and code applies the label values to
   the items it matched. The shared cache is skipped in both directions.
3. **Unchanged.** No relevant saved foods: today's path, including the cache.

**Matching** (code-only path):

- The whole message is tried as one food first, then split on `,`, `and`, `+`,
  `&` and new lines. When the message splits, the whole of it must match a saved
  name exactly (a quantity before or after is allowed), so a saved "Mac and
  cheese" stays one item and "oats and milk" never becomes a saved "Oats and
  Milk Bar".
- A part matches a food when its name matches exactly, ignoring case and
  punctuation, or when every word the user typed appears in exactly one saved
  name ("oats" finds "Quaker Oats"). Two or more candidates means no match.

**Quantities** code can scale, before or after the food's name:

| Typed | Servings |
|---|---|
| nothing, `a`, `an`, `one`, `1` | 1 |
| `2`, `2x`, `x2`, `×2`, `2 servings` | 2 |
| `1/2`, `0.5`, `half` | 0.5 |
| `80g`, `80 g`, `80 grams` against a 40 g serving | 2 |
| `250ml`, `250 ml` against a 250 ml serving | 1 |

A weight or volume only scales when its unit is the serving's unit and the
serving has an amount. Anything else ("a bowl of oats", "100ml oats" against a
gram serving) goes to the AI.

**Logged items** from the library are named after the food, with `×N` when the
servings are not 1: "Quaker Oats ×2". Calories and macros are the label values
times the servings, rounded to whole numbers. Label blanks stay unknown on the
code-only path and are filled by the AI on the AI path. Items carry no emoji, so
they show the formatter's existing fallback.

**Confirmation.** When any item came from the library, the confirmation ends with
the descriptions of those items: "From your foods: Quaker Oats ×2, Skyflakes".

**Clarifications.** A clarification reply always goes to the AI, with saved foods
picked from the original message plus every reply.

**AI outages.** A message the code-only path fully matches logs normally. Anything
else falls back to the existing pending queue, and the retry job uses the library
when it tries again.

### Mini App: Foods tab

- A new tab, shown only when `/api/user` returns `food_library: true`. A
  `?tab=foods` query parameter opens on it.
- A search box filters as the user types. The whole library loads in one request.
- Rows are sorted A–Z and show name, serving and calories.
- Tapping a row opens a form: name, serving wording, serving amount, unit (g, ml
  or none), calories and the four macros. A blank macro means not on the label.
  Save sends the change. A Delete button asks for confirmation with
  `Telegram.WebApp.showConfirm`.
- "Select" adds checkboxes. "Delete N" asks for confirmation, then deletes them
  all at once.
- Empty state: "No saved foods yet. Use /foods in the chat to add some."
- Validation errors from the API show beside the form, for example "You already
  have a food called Quaker Oats".
- A request refused because the Mini App session expired (a 401) shows "Your
  session expired. Close and reopen the app." beside the form, in an alert for
  a bulk delete, or in place of the list.

## Architecture

### Data model — `src/db/schema.sql`

```sql
-- A user's saved foods: label values per serving (/foods, Mini App Foods tab)
CREATE TABLE IF NOT EXISTS food_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,   -- normalizeFoodText(name); matching and duplicates
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

Macros are `REAL` because labels give values such as 0.5 g; rounding happens when
a food is logged. The macro columns use the registry's column names, so the
repository loops over `MACROS`. Adding a macro means adding its column here too.

`food_items` gains `saved_food_id INTEGER` (nullable, no foreign key), in
`schema.sql` and `COLUMN_MIGRATIONS`. It records which saved food an item came
from, for the save-from-log exclusion. Values are still copied at log time, so
editing or deleting a saved food never changes a past log; a deleted food leaves
the id dangling, which is harmless.

### Normalizing — `src/utils/normalize.ts` (new)

`normalizeFoodText` moves out of `AIService.normalizeFood` unchanged (lowercase,
trim, collapse spaces, strip punctuation), so the cache and the library agree.

### Validation — `src/library/validate.ts` (new)

`validateFood(input)` returns a clean saved food or a reason: name 1–100
characters, calories an integer 0–5000 (rounded from decimals), macros blank or
0–500, unit `g` or `ml` only with a positive amount, serving amount at most
10000, serving defaulting to "1 serving". Used by the import preview,
save-from-log and the API.

### Matching — `src/library/match.ts` (new)

Pure functions, no database or AI:

```ts
/** Every part matched and scaled, or null. */
matchMeal(text: string, foods: SavedFood[]): MatchedItem[] | null
/** Up to `limit` foods sharing a word with the text, most shared words first. */
candidatesFor(text: string, foods: SavedFood[], limit = 15): SavedFood[]
/** A food's label values times servings, rounded; blanks stay null. */
scaleFood(food: SavedFood, servings: number): FoodEstimate
```

Plus the helpers they use (`splitMeal`, `parseQuantity`, `findFood`), exported
for tests. `candidatesFor` ignores words under three letters and quantity and unit
words (`g`, `ml`, `grams`, `cup`, `serving`, `servings`, `and`, `with`, `of`).

### Estimator — `src/library/estimator.ts` (new)

```ts
class MealEstimator {
  constructor(library: FoodLibraryRepository, ai: AIService, analytics: Analytics)
  estimate(text: string, provider: string, opts: EstimateOptions): Promise<MealEstimate>
}
type MealEstimate = EstimationResult & {
  source: "library" | "mixed" | "ai" | "cache"
}
```

Items that came from the library carry `saved_food_id`, which is all the
confirmation footer needs.

1. Flag off: `ai.estimate` as today.
2. Load the user's foods. None: `ai.estimate` as today.
3. No `opts.context`: try `matchMeal`. A match returns `source: "library"`.
4. Pick `candidatesFor` the text (with context, the original message plus
   replies). None: `ai.estimate` as today.
5. `ai.estimate` with `savedFoods: candidates`. For each returned item whose
   `saved_food_id` is one of the candidates and whose `servings` is a positive
   number: name it after the food, set calories and every non-blank macro from
   `scaleFood`, keep the AI's value for blanks, and set `saved_food_id`. Any other
   item is kept as the AI gave it, with `saved_food_id` null. `servings` is
   dropped from every item.
6. A database or matching error in steps 2–4 is reported to error tracking
   (`source: "library"`) and the estimate continues as step 1.
7. If the call in step 5 fails, it is reported (`source: "library"`) and tried
   once more as step 1. If that fails too, the error reaches `LogFlow`, whose
   pending queue handles outages.

`source` is `"cache"` when `AIService` reports a cache hit, `"mixed"` when an AI
call produced at least one library item, and `"ai"` otherwise. It emits
`meal_estimated` (see Analytics). It must be given the Analytics `createBot`
returns, so the meal-text opt-out applies.

`LogFlow` and `src/jobs/retry-pending.ts` call `MealEstimator.estimate` instead of
`AIService.estimate`.

### AI — `src/ai/types.ts`, `prompt.ts`, `parse.ts`, `providers/*`, `service.ts`

- `FoodEstimate` gains optional `saved_food_id?: number | null` and
  `servings?: number | null`. `EstimationResult` gains optional `cached?: true`,
  set by `AIService` on a cache hit.
- `EstimateOptions` gains `savedFoods?: SavedFood[]`. When it is non-empty,
  `AIService.estimate` skips the cache read and write and passes
  `formatSavedFoods(savedFoods)` to the provider.
- `AIProvider.estimate(foodDescription, context?, savedFoods?)`: providers append
  the block to the user message, never the system prompt, so the system prompt
  stays identical across users and provider prompt caching keeps working.
- `formatSavedFoods` in `prompt.ts`:

  ```
  Saved foods (label values per serving). If an item is one of these, set saved_food_id to its id and servings to how many servings were eaten, converting the amount eaten using the serving size. Still give your own estimate for every field.
  [12] Quaker Oats, serving 1/2 cup (40 g): 150 kcal, protein 5 g, fat 3 g, fiber 4 g, added sugar not on label
  ```

- The system prompts stay unchanged, so a call without saved foods is
  byte-identical to today's (goal 6). The saved-foods block itself asks for
  `saved_food_id` and `servings` on every item. OpenAI's strict schema forbids
  extra fields, so OpenAI switches to a second schema, with both as required,
  nullable fields, only when saved foods are present.
- `parse.ts`'s `normalizeItems` keeps both fields when they are numbers, null
  otherwise.
- **Parsing a table.** New `FOODS_PARSE_PROMPT` and
  `AIProvider.parseFoods(text): Promise<FoodsParseResult>`, implemented by all
  three providers with an output limit of about 16384 tokens. The reply shape:

  ```json
  {"foods":[{"name":"Quaker Oats","serving":"1/2 cup (40 g)","serving_amount":40,"serving_unit":"g","calories":150,"protein_g":5,"fat_g":3,"fiber_g":4,"added_sugar_g":null}],
   "unreadable":[{"text":"lunch adobo","reason":"no calories"}]}
  ```

  Bad JSON throws `ProviderParseError`, as the other calls do. `AIService.parseFoods`
  records usage with new call type `import` and sends `$ai_generation`. Rows
  failing `validateFood` move to `unreadable`.

### Repository — `src/db/repositories/food-library.ts` (new)

- `listByUser(telegramId)`, sorted by name
- `get(telegramId, id)`
- `upsertMany(telegramId, foods, source)` → `{ added, replaced }`, in one
  transaction
- `update(telegramId, id, fields)` → `"ok" | "not_found" | "name_taken"`
- `deleteMany(telegramId, ids)` → count, or `"not_found"` when any id is not the
  user's (nothing deleted; one transaction)
- `count(telegramId)`

`FoodLogsRepository.create` writes `saved_food_id`. A new
`getItemsByLog(telegramId, logId)` returns a log's items only when the log is the
user's.

### Bot — `src/bot/commands/foods.ts` (new)

- `/foods` and `/foods add <text>`, registered in `src/bot/index.ts`.
- In-memory state per user, like `/edit` and `/delete`:
  `{ pasteUntil, previews }`. `pasteUntil` is a time (unbounded while waiting
  for the first paste, 10 seconds after each paste, null when not waiting), and
  `previews` holds up to five previews by token, so each chunk of a long paste
  keeps its own Save. `message:text` routes to it while waiting for a paste,
  alongside `hasEditState`.
- Callbacks: `foods:add`, `foods:save:<token>`, `foods:cancel`,
  `foods:fromlog:<logId>`, `foods:toggle:<index>:<token>`, encoded in
  `src/bot/utils/callback-data.ts`. The token fingerprints the rows the preview
  showed. A missing preview or a mismatched token answers "This preview expired,
  paste again."
- `LogFlow`'s commit results return the new log's id, so the bot layer can attach
  "Save to my foods". Its confirmation gains the "From your foods" footer.
- `HELP_TEXT` (`src/bot/help.ts`) gains `/foods`.

### Web API — `src/web/api.ts` (additive)

All routes use the existing initData auth.

| Route | Result |
|---|---|
| `GET /api/user` | gains `food_library: boolean` |
| `GET /api/foods` | `{ foods: [...] }`, A–Z |
| `PATCH /api/foods/:id` | partial fields, run through `validateFood`. 200 `{ food }`, 400 `{ error }`, 404, 409 `{ error }` on a name collision |
| `DELETE /api/foods` | body `{ ids: number[] }`, 1–500 ids. 200 `{ deleted }`, 400, 404 when any id is not the user's |

The `/api/foods` routes return 404 when the flag is off.

### Mini App — `src/web/views/app.html`

The Foods tab as described above. Only additive changes, since Telegram caches the
page. Browser events: `miniapp_food_edited` and `miniapp_foods_deleted` with
`{ count }`.

### Analytics

Server events, counts and labels only. No food names or values, which are meal
text:

- `foods_added` `{ count, replaced, source: "import" | "single" | "log" }`
- `meal_estimated` `{ source: "library" | "mixed" | "ai" | "cache", saved_foods_used }`

The import call's `$ai_generation` carries the pasted text in `$ai_input`, like
every estimate. The meal-text opt-out already drops it.

### Docs

- `CLAUDE.md`: the library under Key Components, `food_library` under Database
  Tables, and two lines in the adding-a-macro checklist (the `food_library` column
  and the `formatSavedFoods` line).
- README and changelog.
- `scripts/smoke-providers.ts` gains `--foods`: one live `parseFoods` call.

## Error handling

| Case | Behavior |
|---|---|
| Parse call fails (outage or bad JSON) | "Couldn't read that right now. Try again in a bit." No pending queue. Recorded and reported through `AIService` as usual |
| Parse finds no usable rows | Reply saying a row needs a name, a serving and calories |
| Row without calories or out of range | Listed under "Couldn't read" with the reason |
| Row without a serving | Saved as "1 serving", flagged in the preview |
| Library error while logging | Reported; the estimate falls back to plain AI. Logging never breaks because of the library |
| AI returns an id it was not given, or servings that is not a positive number | That item keeps the AI's numbers |
| Preview lost to a restart, or token mismatch | "This preview expired, paste again." |
| Someone else presses a preview or save-from-log button | Refused, as `/delete` refuses |
| API: invalid fields | 400 with the reason |
| API: rename collides | 409 "You already have a food called …" |
| API: bulk delete includes an id that is not the user's | Nothing deleted, 404 |
| Flag off | `/foods` says not available; no library on logging; `food_library: false`; `/api/foods` 404 |
| `/foods` in a group | Points to a private chat. Save-from-log still works in groups, owner only |
| Prompt injection in a paste (#6) | Reaches only the user's own preview, which they check before saving. A hostile food name reaches only the user's own prompts |

## Testing

- **`match.ts`:** table-driven, one case per code-only row in #31 plus the
  near-misses: ambiguous names, unit mismatch, no serving amount, unknown words.
- **`validate.ts`:** every range and default.
- **`estimator.ts`**, with a fake `AIService`:
  - flag off and an empty library both call `ai.estimate` exactly as today;
  - a fully matched message makes no AI call and reports `source: "library"`;
  - a mixed message passes the candidates and the cache is skipped;
  - label values override the AI's, and blanks take the AI's;
  - an id that was not a candidate, and non-positive servings, are ignored;
  - a clarification never takes the code-only path;
  - a database error falls back and is reported.
- **Repository:** in-memory SQLite. Upsert replaces by normalized name;
  `update` returns `name_taken`; `deleteMany` deletes nothing when one id belongs
  to someone else; every call is scoped to its owner.
- **Migrations:** `saved_food_id` is added to an existing `food_items`.
- **AI:** `parseFoods` against canned replies per provider, as the existing parse
  tests do; `normalizeItems` keeps `saved_food_id` and `servings`; the saved-foods
  block lands in the user message, not the system prompt; a call with saved foods
  neither reads nor writes the cache.
- **`/foods`:**
  - paste → preview → Save writes the rows and emits `foods_added`;
  - Cancel writes nothing;
  - a stale token is refused;
  - another user's press is refused;
  - the group redirect;
  - a command while waiting for a paste stops waiting;
  - save-from-log leaves out library items, and replies when all were.
- **`LogFlow`:** the "From your foods" footer; the commit result carries the log
  id; with the flag off, every existing log test passes unchanged.
- **API:** auth, validation, ownership, all-or-nothing delete, the 409, and 404
  with the flag off.
- **Live:** `bun run scripts/smoke-providers.ts <provider> --foods` for each
  provider before merging.
- **After deploy:** the manual checklist in #31.

## Rollout

1. Merge with `FEATURE_LOCAL_FOOD_DB=false` (the default). Prod behaves as
   before; the migration adds `saved_food_id`.
2. Turn the flag on for the test bot and run the basic rows of #31.
3. Turn it on in prod (Railway variable).
4. Run #31 in full. A week later, record the share of logs with
   `source: "library"` and `"mixed"`.

The Foods tab appears for each user once Telegram refreshes its cached `app.html`.

## Decisions

Recorded so they are not re-litigated.

| Decision | Rejected alternative | Why |
|---|---|---|
| The library lives in the bot | Read or sync the Google Doc | The user's choice. No Google auth, no parsing a free-form doc on every change. |
| Bulk and single add share one parser and preview | A separate parser for typed single foods | One pipeline to build and explain. A parse is a fraction of a cent and happens once per food. |
| Nothing saved without a preview and Save | Save straight away, fix later | The user's rule. Parsed values must be checked against the label. |
| "Save to my foods" on the logged message | Library only from labels | The user's choice. Builds the library from what is actually eaten; values are the AI's, serving "as logged". |
| Browse, edit and delete in the Mini App | Numbered list in chat; chat search; inline mode | The user expects many foods. Chat paging and multi-delete do not scale; inline mode needs BotFather setup and still cannot multi-delete. |
| Code-only match first, AI with saved foods otherwise | Always call the AI with saved foods; code only | Saves calls on repeat meals and still handles "a bowl of oats" and mixed meals. |
| The AI returns id and servings; code multiplies | Trust the AI's numbers for saved foods | Label values come through exactly; the AI only judges what and how much. |
| Up to 15 candidates by shared word | The whole library in every prompt | Keeps input tokens flat with hundreds of foods. Costs synonym misses. |
| Saved-foods block in the user message | In the system prompt | The system prompt stays identical across users, so provider prompt caching keeps working. |
| Skip the shared cache when the library is involved | Cache as usual | A cached reply would ignore the user's labels, and a library-shaped reply would leak them to other users. |
| Macros `REAL` in the library | `INTEGER` like `food_items` | Labels give 0.5 g; rounding after multiplying is more accurate. |
| `saved_food_id` on `food_items` | Match names to exclude library items from save-from-log | An exact link instead of string matching on descriptions with `×N`. |
| Values copied at log time | Logs reference the saved food | History stays as logged when a food is edited or deleted. |
| Previews in memory | A drafts table | Same as `/edit` and `/delete`. A restart mid-preview costs one re-paste. |
| No pending queue for failed imports | Queue and retry like `/log` | An import is not urgent; the user can paste again. |
| Behind `FEATURE_LOCAL_FOOD_DB` | A new flag | The flag already exists, unused, for exactly this. |

## Known limitations

- Synonyms miss: "oatmeal" will not find "Quaker Oats". #31 measures how often
  that matters.
- Foods saved from a log carry AI values and scale only by servings.
- A preview is lost if the bot restarts before Save.
- A paste over 4096 characters arrives as several previews.
- On the code-only path, label blanks stay unknown until `/admin backfill-macros`
  fills them with AI estimates.
- The Foods tab appears only after Telegram refreshes its cached `app.html`.

# AI Usage & Cost Tracking — Design

**Date:** 2026-09-20 (revised 2026-09-21 after design review)
**Status:** Approved for planning
**Related:** [#1 — Detect stale/retired AI model pins](https://github.com/martin0x/TeleCal/issues/1)

## Problem

TeleCal calls OpenAI, Anthropic, or Gemini on every `/log`, clarification, `/edit`
re-estimate, and retry. Nothing records what those calls consume, so there is no way
to answer "what does the bot cost me this month" or "which user drives that cost."

## Goals

1. **Admin cost visibility** — total spend with per-user and per-model breakdowns.
2. **User self-service** — each user can see their own token footprint.
3. **Enforcement-ready** — the schema supports future per-user quotas. Enforcement is
   explicitly *not* built now.

## Non-goals

- Quota enforcement, blocking, or warnings.
- Mini App usage charts.
- Cache-savings reporting ("you avoided $X by cache hits").
- Calendar-month reporting windows.
- Dollar figures shown to non-admin users.
- Automated detection of retired models — that is issue #1.

## Delivery plan

The review surfaced two blocking problems that must be fixed before usage tracking is
meaningful. The work therefore lands as three branches, merged in order. Each is
independently valuable and independently revertable.

### Blocking context

- **`node_modules` has never existed in this repo.** `bun install` has not been run, so
  `bun test` cannot currently execute — `log-flow.test.ts` imports `AIService`, which
  imports the OpenAI SDK. No claim that "the existing suite passes" is credible until
  this is done.
- **`gpt-5-mini` is deprecated**, shutdown 2026-12-11. It is the default provider's
  model for every existing user. Tracking the cost of a call path that is about to stop
  working is wasted effort.

### Branch 1 — `chore/sdk-and-model-refresh`

Mechanical changes, each verifiable by one live call per provider.

1. `bun install`, and confirm the existing suite runs.
2. Bump `@anthropic-ai/sdk` and `@google/generative-ai`, one commit each.
3. Model ids:
   - OpenAI `gpt-5-mini` → **`gpt-5.6-luna`**
   - Gemini `gemini-3-flash-preview` → **`gemini-3.1-flash-lite`**
   - Anthropic **stays** `claude-haiku-4-5-20251001`
4. Remove `temperature: 0.3` from the OpenAI call.
5. `schema.sql`: `users.ai_provider` default `'openai'` → `'gemini'`.

**Verify `gemini-3.1-flash-lite` in the Google console before committing.** Google's
published version ordering is non-monotonic — `gemini-3.1-flash-lite` is listed as stable
*and* prices below `gemini-3.5-flash-lite` — which is odd enough to confirm by hand.

The schema default change affects **only newly inserted rows**. Existing users keep
whatever `ai_provider` value they have. No backfill `UPDATE` is run: provider is a
user-visible `/settings` option, and silently switching someone's AI provider surfaces as
"the bot answers differently now" with no explanation.

**Anthropic retirement watch:** `claude-haiku-4-5-20251001` is current, but its retirement
is published as "not sooner than 2026-10-15", and it is the only small model in
Anthropic's lineup (Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5). If it retires without a Haiku
successor, the honest response is to drop Anthropic from the provider list rather than
silently upgrading users to a model that costs several times more. Tracked in issue #1.

### Branch 2 — `refactor/openai-responses-api`

The only branch carrying real regression risk, deliberately isolated so a bisect has one
possible cause.

1. Bump `openai` from `4.104.0` to `^7.20.0`. This is a three-major-version jump and
   belongs here, not in branch 1, because the Responses API is what justifies it.
2. Migrate `openai.ts` from `client.chat.completions.create` to `client.responses.create`.
3. Adopt strict Structured Outputs; delete OpenAI's markdown-fence-stripping.
4. Set `reasoning: { effort: "none" }`.
5. Set `store: false` on every call.
6. README: note that food descriptions are sent to the user's configured AI provider.

| Chat Completions (current) | Responses (target) |
|---|---|
| `client.chat.completions.create` | `client.responses.create` |
| `messages: [{role:"system"}, {role:"user"}]` | `instructions` + `input` |
| `response_format: { type: "json_object" }` | `text: { format: { type: "json_schema", name, schema, strict: true } }` |
| `choices[0].message.content` | `output_text` (SDK-only convenience, nullable) |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |
| `usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens_details.cached_tokens` |
| — | `usage.output_tokens_details.reasoning_tokens` |
| — | `usage.input_tokens_details.cache_write_tokens` |
| storage implicit | `store: false` — **defaults to `true`** |

**`store: false` is not optional.** The Responses API documents *"Defaults to true when
omitted… response data will be stored for at least 30 days"*. Without it, every food
description a user types and every calorie breakdown returned is persisted to the OpenAI
organization for 30+ days and readable in the platform logs dashboard. TeleCal keeps
conversation state in its own `conversation_state` table and gains nothing from
server-side storage.

This also rules out `previous_response_id` and the Conversations API for the multi-turn
clarification flow: both require storage, and conversation items are documented as exempt
from even the 30-day TTL. History continues to be passed explicitly in `input`.

Note that OpenAI's separate abuse-monitoring logs are retained up to 30 days regardless of
`store`. Disabling those requires Zero Data Retention or Modified Abuse Monitoring, both
subject to OpenAI's prior approval. Not pursued — it is an enterprise approval process for
a personal bot, and `store: false` already covers the retention under our control.

**`reasoning.effort`:** `gpt-5.6-luna` supports `none, low, medium, high, xhigh, max`, and
defaults to `medium`. Omitting the parameter means paying for reasoning tokens on every
calorie lookup. OpenAI's own guidance names classification and fast retrieval as the
`none` use case, which is exactly this workload.

**`temperature` is undocumented for the GPT-5.6 family.** A full-text search of OpenAI's
docs export found no statement either way. The GPT-5.2/5.4 precedent permits it only at
`effort: "none"`; GPT-6 Astra forbids it outright. Omitting it is correct under every
reading, and the documented alternatives (`reasoning.effort`, `text.verbosity`,
`max_output_tokens`) cover what it would have been used for.

### Branch 3 — `feat/ai-usage-tracking`

Rebased onto branches 1 and 2, so `MODEL_PRICING` and the OpenAI usage extraction are
written against the ids and SDKs that are actually in the code.

## Architecture

Accounting happens in one place: `AIService`. Providers report what they consumed;
`AIService` prices it and writes one row per billed call. Command handlers never touch
pricing or usage tables.

```
log-flow / edit / retry-pending
        │  estimate(food, provider, { telegramId, chatId, callType, context? })
        ▼
    AIService ──── cache hit? ──▶ return cached estimate, record nothing
        │
        │ miss
        ▼
    AIProvider.estimate() ──▶ { estimate, usage }
        │
        ├─▶ pricing.calculateCost(usage)
        ├─▶ UsageRepository.record(...)
        └─▶ return estimate  (CacheRepository stores estimate only)
```

**Why the choke point:** the alternative — each call site recording its own usage —
spreads accounting across four files and silently misses any fifth call site added later.
Making `telegramId` a required argument turns "did we track this call?" into a
compile-time question.

## Data model

Appended to `src/db/schema.sql`. `initializeDatabase()` re-runs the whole file at every
boot with `IF NOT EXISTS`, so appending the table *is* the migration.

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- No FK to users: usage history must outlive the user record it describes.
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  -- Subset of input_tokens billed at the cached rate. Nullable: not all providers report it.
  cached_input_tokens INTEGER,
  -- Subset of input_tokens written to cache. Recorded but not separately priced; see Pricing.
  cache_write_tokens INTEGER,
  output_tokens INTEGER NOT NULL,
  -- Subset of output_tokens, NEVER added to it. Billed as output. OpenAI only.
  reasoning_tokens INTEGER,
  cost_usd REAL NOT NULL,
  call_type TEXT NOT NULL,      -- estimate | clarify | edit | retry
  status TEXT NOT NULL,         -- ok | parse_error | no_usage
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date
  ON ai_usage(telegram_id, created_at);
```

`model` is stored per row rather than referencing a pricing table, so historical rows stay
meaningful after a model swap. `cost_usd` is frozen at write time: a later price change
does not silently rewrite past reports.

`chat_id` is recorded but unused by any report in this pass. It is the one dimension that
cannot be reconstructed after the fact, and TeleCal runs in group chats — `smartReply`
exists specifically to handle group name-mentions — so "what is the family group costing
me" should remain answerable later.

### Recording rules

| Situation | Row written? |
|---|---|
| Live provider call, parsed fine | Yes, `status = 'ok'` |
| Live provider call, response unparseable | Yes, `status = 'parse_error'` — the tokens were billed |
| Provider returned no usage block | Yes, zero tokens, `status = 'no_usage'` |
| Cache hit | No — nothing was billed |
| HTTP call threw (network, 4xx, 5xx) | No — no usage data to attribute |
| Model absent from `MODEL_PRICING` | Yes, `cost_usd = 0`, warning logged |

**Every row counts toward cost and token totals, regardless of `status`.** Parse-failure
tokens are money actually spent; excluding them would make `/admin usage` under-report the
real bill, defeating the feature's primary goal. `status` is diagnostic only and is never
surfaced in any bot message.

`status = 'no_usage'` is unreachable for Anthropic, whose `usage` field is required by the
SDK type. It exists for OpenAI and Gemini, where `usage` is optional.

`status = 'parse_error'` becomes near-unreachable for OpenAI once branch 2 lands, since
strict Structured Outputs cannot return malformed JSON. It remains reachable for Anthropic
and Gemini, which still parse free text by hand.

## Pricing

`src/ai/pricing.ts` holds a constant map in USD per 1M tokens. Verified against each
provider's live pricing page on 2026-09-20.

```typescript
// Prices in USD per 1M tokens. Verified 2026-09-20 against:
//   https://developers.openai.com/api/docs/pricing
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.6-luna":             { input: 0.20, cachedInput: 0.02, output: 1.20 },
  "claude-haiku-4-5-20251001":{ input: 1.00, cachedInput: 0.10, output: 5.00 },
  "gemini-3.1-flash-lite":    { input: 0.25, cachedInput: 0.25, output: 1.50 },
}

export function calculateCost(usage: TokenUsage): number
```

Cost formula:

```
cost = (input_tokens − cached_input_tokens) × input
     + cached_input_tokens                  × cachedInput
     + output_tokens                        × output
```

`reasoning_tokens` is **not** a separate term — it is already inside `output_tokens` and
billed at the output rate. Adding it would double-count.

An unrecognised model returns `0` and logs a warning once per model per process. Tokens
are still recorded, so a model swap degrades to "tokens tracked, cost unknown" rather than
dropping data. Issue #1 covers making that degradation visible.

### Known simplifications

- **Cache writes are recorded but priced at the base input rate.** `cache_write_tokens` is
  stored for future analysis, but no `cacheWrite` rate exists in the map. Justification:
  `gpt-5.6-luna` publishes no write premium ($0.20 input / $0.02 cached, nothing else), and
  Anthropic's 1.25x write premium only applies when a request opts in via `cache_control`,
  which TeleCal does not use. **If Anthropic prompt caching is ever enabled, this formula
  must gain a third term** — otherwise cache-write-heavy calls will be under-reported.
- **Gemini's audio input rate ($0.50/1M) is not modelled.** TeleCal sends text only, at
  $0.25/1M.
- **Gemini has no distinct cached-input rate in this map**; `cachedInput` equals `input`,
  so implicit cache discounts, if any, are not reflected.
- **Batch and fast-mode rates are not modelled.** TeleCal uses standard processing.
- **Several Gemini Flash prices double on 2027-01-01.** `gemini-3.1-flash-lite` is not
  among the dated ones as of verification, but the family is volatile. See issue #1.
- **OpenAI's formatting tokens are not itemized.** Per OpenAI's token-counting guide,
  GPT-5-family models emit structural tokens that appear in `output_tokens` but in neither
  the visible text nor `reasoning_tokens`. Bill on `output_tokens`; never derive it from
  the visible response.

## Interface changes

### Provider interface

`usage` must not live on `EstimationResult`: the cache serializes that object into
`estimation_cache`, so token counts from one call would be baked into the cached JSON and
replayed on every later hit. Providers return a wrapper instead.

```typescript
export interface TokenUsage {
  model: string
  inputTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  outputTokens: number
  reasoningTokens?: number
}

export interface ProviderResult {
  estimate: EstimationResult
  usage: TokenUsage
}

export interface AIProvider {
  name: string
  estimate(food: string, context?: string): Promise<ProviderResult>
}
```

Usage extraction per provider, against the SDK versions each branch installs:

| Provider | Input | Cached input | Output | Reasoning | Model |
|---|---|---|---|---|---|
| OpenAI (Responses) | `usage.input_tokens` | `usage.input_tokens_details.cached_tokens` | `usage.output_tokens` | `usage.output_tokens_details.reasoning_tokens` | `response.model` |
| Anthropic | `usage.input_tokens` | `usage.cache_read_input_tokens` | `usage.output_tokens` | — | `response.model` |
| Gemini | `result.response.usageMetadata.promptTokenCount` | `…cachedContentTokenCount` | `…candidatesTokenCount` | — | requested constant |

Gemini's usage is nested under `result.response`, not on the result object itself.

Prefer the model id the API echoes back over the requested constant, since providers may
resolve an alias to a dated snapshot; fall back to the constant when absent. If a provider
returns no usage block, record zeros with `status = 'no_usage'` rather than throwing — a
missing counter must never break calorie logging.

### Service interface

```typescript
export type CallType = "estimate" | "clarify" | "edit" | "retry"

estimate(food: string, provider: string, opts: {
  telegramId: number
  chatId: number
  callType: CallType
  context?: string
}): Promise<EstimationResult>
```

`context` moves into the options object. `AIService` continues to return a plain
`EstimationResult`, so no caller's result handling changes.

### Call sites

| File:line | New options argument |
|---|---|
| `src/bot/conversations/log-flow.ts:148` | `{ telegramId, chatId, callType: "estimate" }` |
| `src/bot/conversations/log-flow.ts:171` | `{ telegramId, chatId, callType: "clarify", context: contextStr }` |
| `src/bot/commands/edit.ts:148` | `{ telegramId: userId, chatId: ctx.chat?.id, callType: "edit" }` |
| `src/jobs/retry-pending.ts:64` | `{ telegramId: entry.telegram_id, chatId: entry.chat_id, callType: "retry" }` |

Three of four already have `chat_id` to hand. `edit.ts` reads it from `ctx`.

## Repositories

`AIService` currently holds a `Database` and hand-rolls SQL for the estimation cache — the
only raw SQL outside `src/db/repositories/` in the codebase. Adding a second data concern
to that class would deepen an inconsistency rather than follow the existing pattern, so the
cache moves out alongside the new usage table.

```typescript
// src/db/repositories/cache.ts — existing SQL moved, not rewritten
export class CacheRepository {
  constructor(private db: Database) {}
  get(normalizedFood: string): EstimationResult | null
  set(normalizedFood: string, result: EstimationResult): void
}

// src/db/repositories/usage.ts
export class UsageRepository {
  constructor(private db: Database) {}
  record(entry: UsageEntry): void
  getUserTotals(telegramId: number, sinceDays: number): UsageTotals
  getAllUserTotals(sinceDays: number): UserUsageRow[]   // joined to users for username
  getModelBreakdown(sinceDays: number): ModelUsageRow[]
}
```

`AIService`'s constructor becomes:

```typescript
constructor(private cache: CacheRepository, private usage: UsageRepository)
```

No `Database` field, no default parameters. `src/bot/index.ts:33` becomes
`new AIService(new CacheRepository(db), new UsageRepository(db))`. There is exactly one way
to assemble the service, so it cannot be handed a cache on one database and a usage repo on
another — a mismatch the type checker would otherwise accept.

`sinceDays` of `0` means all time. Each aggregate returns calls, input tokens, output
tokens, and summed cost.

## Commands

### `/admin usage [7d|30d|all]`

Admin-only, gated by the existing `config.adminUsers` check in `admin.ts`, following the
`args[0]`/`switch` parsing pattern already used for `add`/`remove`/`list`. Default `30d`.
The `/admin` help text at `admin.ts:19-27` gains a line.

```
📊 AI Usage — last 30 days
Total: $1.84 · 412 calls · 186.2k in / 42.1k out

By user:
• 123456789 (@ray) — $0.91 · 205 calls
• 987654321 — $0.63 · 140 calls

By model:
• gpt-5.6-luna — $1.12 · 320 calls
• claude-haiku-4-5-20251001 — $0.72 · 92 calls
```

The per-user list is capped at the **top 10 by cost**, with an `…and N more ($X total)`
line. No length guard exists anywhere in this bot today — `/admin list` and `/pending`
already build unbounded replies — and fixing that bot-wide is out of scope, so this command
simply declines to join them. The model breakdown is naturally bounded.

Full Telegram IDs are shown, matching `/admin list`, so the admin can act on a heavy user
directly. `redactUserId` remains in use for console logs only.

Note that admins bypass the allowlist entirely (`allowlist.ts:12-14`) and `config.adminUsers`
is env-based, not DB-based — so an admin may have usage rows without an `allowed_users`
entry. The per-user join must not assume otherwise.

### `/usage`

Available to any allowlisted user; registered after the allowlist middleware like every
other command, so it needs no access-control code of its own.

```
📊 Your AI usage — last 30 days
47 calls · 21,300 in / 4,800 out tokens
```

**No dollar figure.** Cost is admin-only: currency accuracy and conversion are unsettled,
and exposing per-user spend to allowlist members invites a social dynamic that a calorie
tracker does not need.

Both commands use `smartReply`, consistent with the rest of the bot. A user with no
recorded usage gets an explicit empty-state message rather than a row of zeros.

### Cost formatting (admin output only)

One shared formatter: below $0.01 show four decimals (`$0.0043`), at or above show two
(`$1.84`). A single call costs roughly $0.0002, so two-decimal formatting would render a
light month as `$0.00` — which reads as broken rather than cheap. A bare `$0.00` never
appears; the empty state fires instead.

### Discoverability

`/usage` must be added to:

- the `/start` help text, `src/bot/index.ts:45-60`
- the README command table, `README.md:74-87`

`bot.api.setMyCommands` is not called anywhere in this repo, so Telegram's autocomplete menu
needs no change.

## Testing

Bun's test runner with in-memory SQLite, test files co-located with source.

**Test DDL is currently hand-copied.** No test reads `schema.sql`; each repository test
inlines its own `CREATE TABLE` in `beforeEach`, and they have already drifted —
`food-logs.test.ts:14-21` omits the foreign key that `schema.sql:29` declares. Adding two
more hand-copies would extend the problem.

Introduce `src/db/test-helpers.ts` exporting `createTestDb()`, which reads `schema.sql` and
applies it to `:memory:`. **Use it for new test files only.** The eight existing tests are
not retrofitted — that is unrelated churn that would make this branch's diff harder to
review.

New and changed tests:

- `src/ai/pricing.test.ts` — cost math per known model; cached-token arithmetic; unknown
  model returns 0 with tokens intact; zero tokens returns 0.
- `src/db/repositories/usage.test.ts` — `record` round-trips every column; each aggregate
  sums correctly across users, models, and the `sinceDays` boundary.
- `src/db/repositories/cache.test.ts` — get/set round-trip after the extraction.
- `src/ai/service.test.ts` — against fake repositories, no SQLite: a row is written on a
  live call; **no** row on a cache hit; a `parse_error` row when the response parses badly;
  a throwing provider writes nothing and propagates the error.
- Per-provider tests asserting usage extraction from each SDK's mocked response shape,
  including the missing-usage fallback.
- `src/bot/commands/usage.test.ts` — rendering, including the empty state and the
  sub-cent formatter.
- `src/bot/conversations/log-flow.test.ts:151` — **existing assertion must be updated.** It
  asserts the exact positional call `estimate("200g grilled", "openai", expect.stringContaining("chicken"))`,
  which the options-object signature breaks.
- `src/jobs/retry-pending.test.ts` — **new.** Asserts a usage row is written with
  `callType: "retry"` and the correct `telegram_id`. This is a background job whose failures
  are never seen interactively, and it currently has zero coverage.

`edit.ts` is deliberately left untested: it is a foreground path where a mistake surfaces
immediately, and testing it requires a grammy `Context` mock that does not exist in this
repo yet.

Fake repositories use `as unknown as` casts, matching the pattern already at
`log-flow.test.ts:87`. Extracting interfaces (`UsageWriter`, `EstimationCache`) would remove
the casts but adds type declarations this codebase does not otherwise use.

## Decisions

Recorded so they are not re-litigated.

| Decision | Rejected alternative | Why |
|---|---|---|
| Rolling windows (`7d`/`30d`/`all`) | Calendar months | Avoids converting UTC `created_at` against per-user timezones. Cost: totals never exactly match a provider's monthly invoice. Switching later needs `src/utils/dates.ts` helpers and a changed `WHERE`. |
| One row per call | Daily rollups; rows + rollup job | A few hundred rows/month. Rollups lose the detail needed to explain a spike. |
| Pricing as a code constant | Env vars; DB table; price-at-read-time | Version-controlled and reviewable; a price change is a one-line commit. Freezing `cost_usd` at write time keeps past reports stable. |
| `status` enum | `success` boolean | A boolean cannot distinguish "billed but wasted" from "billed, amount unknown". |
| Cache hits record nothing | Zero-cost row per hit | Nothing was billed, and cache-savings reporting is a non-goal. Consequence: `/usage` counts billed calls, not `/log` invocations. |
| `chat_id`, `reasoning_tokens`, `cached_input_tokens`, `cache_write_tokens` stored now | Add when needed | All four are free to add today and require an `ALTER TABLE` plus unrecoverable history later. |
| No FK to `users`; no pruning | FK; retention job | Usage history must outlive the user row. The table will not reach a megabyte in a decade. |
| `CacheRepository` extracted | Default-parameter DI on the existing constructor | Removes the only raw SQL outside `repositories/`, and makes the service assemblable exactly one way. |
| Stay on Chat Completions → **reversed**, migrate to Responses | Deferring the migration | Initially deferred as risk; reversed because OpenAI recommends Responses for new work and strict Structured Outputs removes the JSON-coercion prompt and fence-stripping. Isolated on its own branch. |
| `store: false` | Default storage; ZDR | Default retains user food descriptions 30+ days. ZDR is an enterprise approval process for a personal bot. |
| New users default to Gemini | Backfill all users | Provider is a user-visible setting; changing it silently is unexplained behavior change. |
| Structured Outputs for OpenAI only | Also Anthropic/Gemini structured modes | Each has its own mechanism and its own testing; this branch carries enough. |
| Startup warning + `/admin models` | Scraping deprecation pages | Deferred entirely to issue #1. |

## Known limitations

**`estimation_cache` is global**, keyed by normalized food across all users. If user A pays
for "chicken adobo", user B's identical entry is free. Per-user cost is therefore *billed*
cost — the right number for reconciling an API bill, a slightly unfair one as a future quota
basis. Anyone building enforcement should decide deliberately whether a cache hit counts
against the user who benefits from it.

**Usage recording is best-effort.** A failure to write a usage row must never fail a food
log. Recording is wrapped so an error is logged and swallowed.

**No historical backfill exists.** Reports start empty on the day this ships.

**`reasoning.context` defaults to `all_turns` for the GPT-5.6 family**, unlike earlier
models. Irrelevant while TeleCal passes history explicitly with `store: false`, but it would
matter if server-side state were ever adopted.

# Handoff — AI usage tracking work

**Date:** 2026-09-22
**State:** All three branches **merged to `main` and pushed** (`a1cfaf7..f8a190d`,
29 commits, fast-forward). Feature branches deleted. Railway deploys from `main`.
OpenAI's live path is still unverified — see "Deferred on branch 2" (#4).

## Where things stand

All three planned branches were executed in sequence and are now all on `main`.

| Branch | Plan | Status |
|---|---|---|
| `chore/sdk-and-model-refresh` | `.../2026-09-21-sdk-and-model-refresh.md` | **MERGED** — 7 commits, was `0121cb8` |
| `refactor/openai-responses-api` | `.../2026-09-21-openai-responses-api.md` | **MERGED** — 4 commits, was `ba9a200`, live checks deferred to #4 |
| `feat/ai-usage-tracking` | `.../2026-09-21-ai-usage-tracking.md` | **MERGED** — 10 commits, was `f8a190d` |

`main` is at `f8a190d` and pushed to `origin/main`. The three branch labels are
deleted; every commit is an ancestor of `main`, and the SHAs above recover them.

Design doc: `docs/superpowers/specs/2026-09-20-ai-usage-tracking-design.md`.
It carries a Decisions table recording what was rejected and why — read that
before reopening a settled question.

## To resume

All three plans are executed and shipped. What remains is the live verification
parked in **#4** (needs OpenAI credits) and whatever the prod deploy surfaces.

### Pre-deploy checks that were run

- **Schema migration against an existing database.** Seeded a pre-branch-3
  database with a user and a food log, then applied the new `schema.sql` the way
  `initializeDatabase()` does. `ai_usage` and `idx_ai_usage_user_date` are
  created; existing rows survive untouched. The migration is purely additive —
  every statement is `IF NOT EXISTS` and no column is altered or dropped.
- **Full boot path**, everything `src/index.ts` does except `bot.start()`:
  db init, `createBot()`, web server, reminder job, retry-pending job. All clean.
  Polling was deliberately not started so as not to steal `getUpdates` from the
  live bot.

The per-task ledger for branch 1 is at
`.superpowers/sdd/2026-09-21-sdk-and-model-refresh/progress.md` (gitignored, on
disk only). It holds every task report, review, and ruling. A new session does
not need it to continue — this file plus `git log` is enough — but it is the
record if you want to audit a decision.

## What branch 1 did

- Established the first verified test baseline: **71 pass / 0 fail across 10 files**.
  `node_modules` had never been installed in this repo before.
- Added `scripts/smoke-providers.ts` — one live API call per provider. This is the
  repeatable verification gate branches 2 and 3 depend on. Documented in `CLAUDE.md`.
- Bumped `@anthropic-ai/sdk` 0.30.1 → 0.127.0 (97 minor versions; `anthropic.ts`
  needed no changes — verified against the installed types, not just assumed).
- `@google/generative-ai` was already at latest (0.24.1) — no-op.
- OpenAI: `gpt-5-mini` → `gpt-5.6-luna`, and deleted `temperature: 0.3`.
- Gemini: `gemini-3-flash-preview` → `gemini-3.1-flash-lite`.
- `users.ai_provider` schema default flipped `'openai'` → `'gemini'`, **new rows only**,
  no backfill. Existing users keep their stored provider deliberately.

## What branch 2 did

Executed `docs/superpowers/plans/2026-09-21-openai-responses-api.md` in full
except for the two live checks below. 4 commits, `0121cb8..4f2edf9`.

- `openai` 4.104.0 → **7.20.0**. `bunx tsc --noEmit` passed with **zero** errors
  after the three-major bump — the plan expected breakage in `openai.ts` and
  there was none, so no interim compile fixes were needed.
- `OpenAIProvider` takes an optional `client?: OpenAI` constructor argument.
  `new OpenAIProvider()` is unchanged, so `src/ai/service.ts` was not touched.
- `src/ai/providers/openai.test.ts` — 6 contract tests, committed red first
  (all 6 failed on `this.client.chat.completions` being undefined), then green.
- `estimate()` now calls `client.responses.create` with `store: false`,
  `reasoning: { effort: "none" }`, and strict `json_schema` Structured Outputs.
  Fence-stripping and `json_object` mode are gone. Signature unchanged.
- **The `as any` cast the plan offered was not needed and is not in the code.**
  v7.20.0's types accept the whole request object as written, and `'none'` is a
  real member of the exported `ReasoningEffort` union in
  `node_modules/openai/resources/shared.d.ts` — not a hole in the types.
- README gained a Privacy section.
- Suite: **77 pass / 0 fail across 11 files** (71 baseline + 6 new).

Confirmed for branch 3: all four usage paths it expects exist in the v7 types —
`usage.input_tokens`, `usage.input_tokens_details.cached_tokens`,
`usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens`
(plus `input_tokens_details.cache_write_tokens`). Verified against
`responses.d.ts:6925-6966`, from types only — no live response has been seen.

## Deferred on branch 2

Tracked in **[#4](https://github.com/martin0x/TeleCal/issues/4)** — no longer on
the critical path. Credits are not available for the foreseeable future, so this
is parked deliberately rather than pending. Do not block branch 3 on it.

1. **Task 3 Step 4 — live smoke.** `bun run scripts/smoke-providers.ts openai`
   still returns `429 You have no credits remaining`. So the Responses migration
   has never made a real call, and `gpt-5.6-luna` is *still* unvalidated. These
   are now two unverified things stacked on each other: if the first live call
   fails, the cause could be the model id (branch 1) or the API migration
   (branch 2). That is exactly the ambiguity the three-branch split existed to
   prevent — accepted knowingly to keep the code moving.
2. **Task 3 Step 5 — confirm `store: false` is honored.** Requires opening
   <https://platform.openai.com/logs?api=responses> and confirming the smoke
   call does *not* appear. No test can prove this: the unit test asserts the flag
   was *sent*; only the dashboard proves the server obeyed it. Since no live call
   has been made, there is nothing to look for yet.

Full steps, expected output and failure triage live in #4.

## What branch 3 did

Executed `docs/superpowers/plans/2026-09-21-ai-usage-tracking.md` in full.
10 commits, one per task, `a5c0588..732bc25`. Suite went 77 → **132 pass / 0 fail
across 22 files**; `bunx tsc --noEmit` clean at every task boundary.

- `ai_usage` table + `createTestDb()`, which reads the real `schema.sql` instead
  of hand-copying DDL. Production applies the schema the same way (`db.run` on
  the whole multi-statement file), so the helper cannot drift from it.
- `src/ai/pricing.ts` — `MODEL_PRICING` for all three models and `calculateCost`.
  Reasoning tokens are never added on top of output; cache writes carry no
  surcharge; unknown models warn once and cost 0 rather than dropping the row.
- `UsageRepository` with `record`, `getUserTotals`, `getAllUserTotals`,
  `getModelBreakdown`. Non-`ok` rows still count toward totals — they were billed.
- `CacheRepository` extracted, so `AIService` holds no `Database`. That is what
  made Task 6's accounting testable against fakes.
- All three providers return `ProviderResult { estimate, usage }` and take an
  injectable client. Anthropic and Gemini had no tests before; they do now.
- `AIService.estimate(food, provider, opts)` records one row per billed call.
  Cache hits record nothing. A `SyntaxError` records a `parse_error` row; any
  other throw records nothing. Every write is try/caught — accounting can never
  fail a food log.
- `/usage` (tokens only, no dollars) and `/admin usage [7d|30d|all]` (dollars,
  per-user and per-model, list capped at 10 rows).

### Divergence from the plan: a fifth call site

The plan's Task 7 is titled "Update the four call sites" and lists `log-flow.ts`
(x2), `edit.ts` and `retry-pending.ts`. **There is a fifth:**
`scripts/smoke-providers.ts` also calls `estimate()`. `tsconfig.json` includes
only `src/**/*`, so `bunx tsc --noEmit` cannot see it — the script broke at
runtime with `undefined is not an object (evaluating 'opts.context')` and a
green typecheck. Fixed in the Task 6 commit. If you add another entry point
outside `src/`, nothing will typecheck it.

## Verified live (Gemini only)

Gemini is the one provider with a working key, so it carries the live proof:

- Usage field paths confirmed against a real response: `promptTokenCount` → 222
  `inputTokens`, `candidatesTokenCount` → 109 `outputTokens`, priced $0.000219.
  No fake can prove this mapping; this does.
- A real end-to-end row written to `ai_usage` from a live `/log`-equivalent call,
  correctly priced.
- `/usage` renders with **no** dollar sign; `/admin usage` renders the total,
  the per-user row and the model breakdown; `7d` and `all` windows both render.
- Logging the same food twice left the call count at 1 — cache hits really do
  record nothing.

**OpenAI and Anthropic usage mappings are still unproven against live responses**
(no credits / no key). Both are covered by fakes only.

## Known cosmetic issue

Messages read "1 calls" — nothing pluralizes. Visible in both `/usage` and
`/admin usage`. The plan specified these strings verbatim and its tests assert
them, so this was left alone rather than changed unasked.

## Blockers you need to resolve

### 1. The OpenAI account has zero API credits

`bun run scripts/smoke-providers.ts openai` returns
`429 You have no credits remaining`.

Two consequences:

- **`gpt-5.6-luna` shipped without a live call validating it.** A 429 is rejected at
  the billing layer *before* the model id is resolved, so no retry could have
  verified it. If the id is wrong, OpenAI calls will 400 into `pending_entries` —
  a one-line fix, detectable the moment credits exist.
- **Your bot is currently broken for existing users.** `openai` is their stored
  provider, so their `/log` calls fail. The branch-1 fix wave added a `/settings`
  hint to the give-up message so they can self-serve, but the underlying cause is
  the credit balance.

**This gate was not met, and will not be met soon** — there is no budget for
credits right now. Branch 2 was executed anyway, by explicit decision, with its
two live checks parked in #4. The isolation the split was buying is spent: the
next OpenAI failure has two candidate causes.

### 2. `ANTHROPIC_API_KEY` is empty

The SDK bump was verified by static types only, never by a live call. Add the key
if you want that gap closed; Anthropic's model id did not change, so the risk is
limited to a runtime-only SDK break.

## Carried into branch 2 — disposition

- **No reasoning-effort control on `gpt-5.6-luna`.** ✅ **RESOLVED.** Branch 2 sets
  `reasoning: { effort: "none" }` on every Responses call.
- **`zod` optionalPeer resolution conflict.** ✅ **RESOLVED — there was none.**
  `@anthropic-ai/sdk` 0.127.0 wants `zod ^3.25.0 || ^4.0.0` and `openai` 7.20.0
  wants `^3.25 || ^4.0`. Both declare it as an *optionalPeer*, the ranges overlap,
  and `zod` is not installed. Nothing to reconcile.
- **Five `?? "openai"` fallbacks contradict the `'gemini'` schema default.**
  ⚠️ **STILL OPEN — and the handoff's plan for it was wrong.** This note assumed
  "branch 2 already touches three of those files." It does not. Branch 2's plan
  scopes the change to `openai.ts` alone, and its Task 5 Step 3 *explicitly
  forbids* `service.ts`, `types.ts`, `anthropic.ts` and `gemini.ts` from appearing
  in the diff. The plan won, so the fallbacks are untouched. `retry-pending.ts:62`
  is the one with real teeth — it can process entries whose user row is gone.
  **Give this its own branch, or fold it into branch 3.**
- **`scripts/smoke-providers.ts` logs `error.message`** (can echo a masked
  `sk-...abcd` fragment on a 401). ⚠️ **STILL OPEN**, same reason: the note said
  "fold it in when branch 2 touches that file," and branch 2 never touches it.
  Carry it to branch 3.

## Accepted, no action needed

- **Existing users keep `openai` as their stored provider — no migration.** Asked
  and declined 2026-09-22. Their `/log` calls fail while the account has no
  credits; the branch-1 `/settings` hint lets them switch by hand. Do not propose
  an `openai` → `gemini` backfill again.

- A third-party source calls `gemini-3.1-flash-lite` "preview" while Google's own
  page says Stable. The live API accepted it and returned a valid structured
  response — that outranks a third-party summary.
- `src/db/repositories/users.test.ts` asserts `DEFAULT 'openai'` from its own inline
  fixture, so it passes despite `schema.sql` now saying `'gemini'`. Deliberate: it
  tests `UsersRepository` against its own DDL, not the schema. A comment now marks
  the divergence. Branch 3 introduces `createTestDb()` and unifies it — do not fix
  it in passing or you will collide with that work.

## Open GitHub issue

[#1 — Detect stale/retired AI model pins](https://github.com/martin0x/TeleCal/issues/1),
opened during design. Carries the known retirement dates
(`claude-haiku-4-5-20251001` not sooner than 2026-10-15; `gpt-5-mini` shutdown
2026-12-11) and three open questions about what staleness detection should do.

# Handoff — AI usage tracking work

**Date:** 2026-09-21
**State:** Branch 1 of 3 complete and review-clean, NOT merged.

## Where things stand

Three branches were planned. Only the first exists.

| Branch | Plan | Status |
|---|---|---|
| `chore/sdk-and-model-refresh` | `docs/superpowers/plans/2026-09-21-sdk-and-model-refresh.md` | **DONE** — 7 commits, `856b794..a270a31`, unmerged |
| `refactor/openai-responses-api` | `docs/superpowers/plans/2026-09-21-openai-responses-api.md` | Not started |
| `feat/ai-usage-tracking` | `docs/superpowers/plans/2026-09-21-ai-usage-tracking.md` | Not started |

`main` is at `856b794`. Nothing has been merged.

Design doc: `docs/superpowers/specs/2026-09-20-ai-usage-tracking-design.md`.
It carries a Decisions table recording what was rejected and why — read that
before reopening a settled question.

## To resume

Cut branch 2 from branch 1 (or from `main` after merging branch 1), then execute
`docs/superpowers/plans/2026-09-21-openai-responses-api.md` with the
`superpowers:subagent-driven-development` skill.

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

**Branch 2 is the OpenAI Responses API migration.** Add credits and run
`bun run scripts/smoke-providers.ts openai` BEFORE starting it — otherwise any
failure has two candidate causes (bad model id vs. bad API migration) and you lose
the isolation the three-branch split was buying.

### 2. `ANTHROPIC_API_KEY` is empty

The SDK bump was verified by static types only, never by a live call. Add the key
if you want that gap closed; Anthropic's model id did not change, so the risk is
limited to a runtime-only SDK break.

## Carried into branch 2 (deferred deliberately, with reviewer agreement)

- **No reasoning-effort control on `gpt-5.6-luna`.** It runs on Chat Completions at
  default effort and may be silently billing reasoning tokens. Branch 2 sets
  `reasoning: { effort: "none" }` and retires this.
- **Five `?? "openai"` fallbacks now contradict the `'gemini'` schema default** —
  `src/ai/service.ts:29`, `src/jobs/retry-pending.ts:62`, `src/bot/commands/log.ts:78`
  and `:112`, `src/bot/commands/edit.ts:147`. Harmless while the upsert middleware
  guarantees a user row, except `retry-pending`, which can process entries whose user
  row is gone. Branch 2 already touches three of those files — unify on one exported
  constant there.
- **`bun.lock` now carries a `zod` optionalPeer** from the Anthropic SDK, and the
  `openai` 4→7 bump declares `zod` too. Watch for a resolution conflict.
- **`scripts/smoke-providers.ts` logs `error.message`**, which on a real OpenAI 401
  can contain a *masked* key fragment (`sk-...abcd`). Accepted as low risk for a
  dev-only script; fold a `sk-[\w-]+` redaction in when branch 2 touches that file.

## Accepted, no action needed

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

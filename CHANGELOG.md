# Changelog

All notable changes to TeleCal are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project deploys continuously from `main`, so entries are dated rather than
tied to release tags.

## [Unreleased]

### Added

- **Landing page analytics and the access-request funnel.** With a PostHog
  key set, the landing page loads PostHog cookieless (in-memory, no cookies or
  storage) with autocapture and replay off, and records page views and which
  Request access button was tapped (`nav`, `hero`, `pricing`, `footer`). The
  bot records `access_requested` (with `source`: `landing`, `group` or `bot`),
  `access_approved` (via the Approve button or `/admin add`) and
  `access_declined`. No visitor is linked from the page into Telegram; the
  funnel is counted in totals.
- **LLM analytics in PostHog.** Every billed AI call (estimate, clarify,
  edit, retry, backfill) is sent as a `$ai_generation` event with the full
  prompt and raw reply, provider, model, token counts, latency, and TeleCal's
  own cost, so PostHog's numbers match `/admin usage`. Unparseable replies are
  error events that still carry the reply. Cache hits and calls that never got
  a reply send nothing. `ai_usage` stays the source of truth for cost.
- **Error tracking in PostHog.** Errors from update handlers, AI provider
  calls, `ai_usage` writes, the reminder, retry and backfill jobs, and
  unhandled rejections or exceptions are reported to PostHog with the
  hashed user ID and where they came from. Routine Telegram failures (a user
  blocked the bot, an edit to identical text) stay as log lines only. An
  uncaught exception is now reported, flushed, and exits the process for
  Railway to restart.
- **`scripts/smoke-posthog.ts`** — sends one test exception to PostHog.
- **Public landing page at `/`**, with a Request access button.
- **In-bot access requests.** Strangers get a Request access button; admins
  get Approve/Decline in one tap.
- **`/admin announce-privacy [confirm]`**: previews, then sends, a one-time
  privacy notice to every allowlisted user and admin. Receipts are stored per
  user, so re-running only retries people it couldn't reach.
- **`/admin requests`** — lists pending access requests, each with its own
  Approve/Decline buttons.
- **`scripts/build-landing-assets.sh`** — rebuilds the landing page's images
  (the `og:image` preview and phone screenshots) from raw screenshots dropped
  in `scripts/screenshots/`.

### Changed

- **The group "Request access" link now opens `/start group`** instead of
  `/start access`, so group-chat requests aren't counted as landing page
  ones.
- **`parse_error` rows in `ai_usage` now record the tokens that were billed**
  instead of zeros and model `unknown`: providers attach their usage to the
  parse error.
- **Privacy: PostHog analytics (US) is now a data processor.** It will
  receive error reports, each AI call's full prompt and output (so food
  descriptions), and page views (cookieless on the landing page), under a hashed Telegram ID. The
  README Privacy section, the landing page FAQ ("What happens to my data?")
  and `/start` say so, and `/admin announce-privacy` sends existing users a
  one-time notice. OpenAI calls keep `store: false`, but the 0.2.0 note
  calling it "a privacy requirement" no longer holds on its own, since
  PostHog now receives the same prompts.
- **Graceful shutdown on Railway redeploys.** SIGTERM is now handled like
  SIGINT, and `railway.json` sets `drainingSeconds: 10` (Railway's default is
  0, i.e. an immediate SIGKILL) so queued analytics events are flushed before
  exit. Groundwork for PostHog (#7); no events are sent yet.
- **The Mini App moved to `/app`.** Old View Charts buttons redirect
  automatically.
- **Non-allowlisted users now get an invite prompt** instead of
  "⛔ invite-only".
- **`/admin add` also approves any open access request** for that user,
  pending or declined, so the two paths can't disagree.
- **`/log` confirmation uses buttons.** `✅ Log {total} cal`, `✏️ Change` and
  `✖️ Cancel` replace typing "yes"/"no". After a tap the message is edited in
  place, so it still shows exactly what was confirmed. Typing still works.
- **`/delete` confirmation uses buttons**: `🗑 Delete`, `🗑 Delete all` and
  `✖️ Cancel`. Picking an item is still typed.
- **Item summaries no longer draw a `─` rule**, which wrapped onto a second line
  on narrow screens. Items sit in a quote box with a bold total, and messages
  carrying one are sent with Telegram's HTML formatting. `/today`, `/week` and
  `/month` likewise separate the total from the list with a blank line instead
  of a `━` rule, for the same reason.
- **Replies breathe a little more** (#19). A blank line now separates a
  message's sections: the header, the quote box of items and the total in
  `/log` and retried-entry messages, and the title, numbers and goal lines in
  reminders, `/usage`, `/week` and `/month`.
- Confirmation buttons only act for the user they were sent to, and only on the
  estimate or items their message shows: an old Log button cannot confirm a
  newer estimate.

## [0.2.0] — 2026-09-22

AI usage and cost tracking, plus a model and SDK refresh. Planned as three
branches (`docs/superpowers/plans/2026-09-21-*.md`), executed in sequence, and
merged to `main` as 30 commits.

### Added

- **`/usage`** — your own AI call count and token totals for the last 30 days.
  Shows no dollar figures; cost is admin-only by design.
- **`/admin usage [7d|30d|all]`** — per-user and per-model cost in USD, with
  call and token totals. Admin-only. The user list is capped at 10 rows with a
  summarised remainder, so the message cannot silently exceed Telegram's
  4096-character limit.
- **Per-call cost accounting.** New `ai_usage` table records one row per billed
  AI call: tokens (input, cached, cache-write, output, reasoning), USD cost,
  provider, model, call type (`estimate`/`clarify`/`edit`/`retry`), and status.
  - Cache hits record nothing — nothing was billed.
  - Reasoning tokens are stored for diagnostics but never added to cost; they
    are already billed as output tokens.
  - Cache writes are recorded but priced at the base input rate.
  - Rows count toward totals regardless of status, because those tokens were
    charged either way.
  - Every write is wrapped in try/catch: accounting can never fail a food log.
- **`src/ai/pricing.ts`** — `MODEL_PRICING` for all three models and
  `calculateCost()`. An unknown model warns once and records at cost 0 rather
  than dropping the row, so tokens are never lost to a stale price map.
- **Privacy section in the README**, describing what is sent to which provider
  and what TeleCal does about retention.
- **Test infrastructure**, where there had been almost none:
  - `createTestDb()` builds an in-memory database from the real `schema.sql`,
    instead of the hand-copied `CREATE TABLE` statements the older test files
    use (which had already drifted from production DDL).
  - First-ever tests for the Anthropic provider, the Gemini provider,
    `AIService`, and the `retry-pending` background job.
  - Suite grew to 132 tests across 22 files.
- **`scripts/smoke-providers.ts`** — one live API call per provider to verify a
  model id and its parameters are accepted.

### Changed

- **OpenAI moved from Chat Completions to the Responses API**, with strict
  Structured Outputs replacing `json_object` mode and markdown-fence stripping.
  - `store: false` on every call, so food descriptions are not retained in the
    OpenAI organization's logs. This is a privacy requirement, not a tuning knob.
  - `reasoning: { effort: "none" }`, since the model defaults to `medium` and
    would otherwise bill reasoning tokens on every calorie lookup.
  - `previous_response_id` and the Conversations API are deliberately not used;
    both require `store: true`. Conversation state stays in TeleCal's database.
- **Model pins:** OpenAI `gpt-5-mini` → `gpt-5.6-luna` (and the unsupported
  `temperature` parameter removed); Gemini `gemini-3-flash-preview` →
  `gemini-3.1-flash-lite`.
- **Dependencies:** `openai` 4.104.0 → 7.20.0; `@anthropic-ai/sdk` 0.30.1 →
  0.127.0. `@google/generative-ai` was already current at 0.24.1.
- **Default AI provider for new users** is now `gemini` instead of `openai`.
  Applies to new rows only — existing users keep their stored provider.
- **Internal APIs** (relevant only if you have local patches):
  - `AIProvider.estimate()` returns `ProviderResult { estimate, usage }` rather
    than a bare `EstimationResult`.
  - `AIService.estimate(food, provider, opts)` now requires an options object
    carrying `telegramId`, `chatId`, and `callType`, so every call is attributable.
  - `new AIService(cacheRepo, usageRepo)` replaces `new AIService(db)`. The
    estimation cache moved into a new `CacheRepository`, leaving `AIService`
    with no `Database` — which is what makes the accounting testable.
  - All three providers accept an optional client in their constructor for
    test injection. The no-argument form is unchanged for production.

### Fixed

- The retry job's give-up message now points users at `/settings` so they can
  switch providers themselves instead of being stuck.
- `scripts/smoke-providers.ts` was updated for the new `estimate()` signature.
  It is a fifth call site that `tsc` cannot see — `tsconfig.json` includes only
  `src/**/*` — so it had broken at runtime behind a green typecheck.

### Known gaps

- **OpenAI's live path is unverified.** The account has no API credits, so
  `gpt-5.6-luna` and the Responses migration have never completed a real call,
  and `store: false` has never been confirmed honored in the OpenAI logs
  dashboard. Tracked in
  [#4](https://github.com/martin0x/TeleCal/issues/4). Gemini is verified live;
  Anthropic has no key configured and is covered by fakes only.
- **Existing users whose stored provider is `openai` cannot log food** while the
  credit balance is zero. No migration was performed, by decision — they can
  switch with `/settings`.
- Messages read "1 calls"; nothing pluralizes.
- Five `?? "openai"` provider fallbacks now contradict the `gemini` schema
  default. Harmless except in `src/jobs/retry-pending.ts`, which can process
  entries whose user row no longer exists.
- No detection for stale or retired model pins —
  [#1](https://github.com/martin0x/TeleCal/issues/1) carries the known
  retirement dates.

---

Changes before 0.2.0 are not catalogued here; see `git log` and the design
documents in `docs/plans/`.

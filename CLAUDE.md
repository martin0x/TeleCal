# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeleCal is a Telegram bot for conversational calorie tracking with AI-powered food estimation. Users describe what they ate in natural language, and the bot uses AI (OpenAI/Anthropic/Gemini) to estimate calories.

## Commands

```bash
bun run dev      # Start with hot reload
bun run start    # Production start
bun test         # Run all tests
bun test src/ai  # Run tests in specific directory
bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]   # one live API call to verify a provider; --protein exercises the batch call; with POSTHOG_* set, also sends the $ai_generation
bun run scripts/smoke-posthog.ts   # sends one test exception to PostHog; needs POSTHOG_API_KEY and POSTHOG_ID_SECRET
bun run scripts/telegram-mock/render.ts && bash scripts/build-landing-assets.sh   # re-render the landing page's Telegram screenshots from the bot's real formatters (macOS, Chrome)
```

`smoke-providers.ts` needs `TELEGRAM_BOT_TOKEN` set even though it makes no Telegram calls — it imports `AIService`, which imports `src/config.ts`, which throws on a missing token.

## Architecture

### Core Flow
1. User sends `/log` command → starts conversation state machine
2. User describes food → AI estimates calories with multi-turn clarification if needed
3. User confirms → saved to SQLite database
4. Background jobs handle reminders and retry failed AI calls

### Key Components

**Entry Point** (`src/index.ts`): Initializes database, creates bot, starts web server, launches background jobs.

**Bot Layer** (`src/bot/`):
- `index.ts` - Bot setup, middleware chain, command registration
- `commands/` - Command handlers (log, today, week, month, edit, delete, settings, pending, admin)
- `utils/smart-reply.ts` - Send every reply through `smartReply`/`smartEdit`: in groups they quote the user's message, or name the user when there is nothing to quote
- `conversations/log-flow.ts` - State machine for `/log` flow (awaiting_input → clarifying → confirming)
- `middleware/allowlist.ts` - Gate: allowlisted users pass; strangers get an invite prompt and can file an access request (`access.ts` handles admin Approve/Decline)

**AI Service** (`src/ai/`):
- `service.ts` - Provider abstraction with caching layer
- `providers/` - OpenAI, Anthropic, Gemini implementations with shared `AIProvider` interface
- Caching uses `estimation_cache` table keyed by normalized food description

**Database** (`src/db/`):
- Uses `bun:sqlite` (built-in SQLite)
- Repository pattern for each table
- Schema in `src/db/schema.sql`
- `src/db/migrations.ts` adds columns that `IF NOT EXISTS` cannot; runs on every boot after the schema

**Web Server** (`src/web/`):
- Landing page at `/` (`views/landing.html`, `{{BOT_USERNAME}}`/`{{BASE_URL}}`/`{{ANALYTICS}}` filled at startup); images in `public/` served at `/assets/*`
- `analytics-snippet.ts` - PostHog for the web pages (cookieless, automatic capture off); `{{ANALYTICS}}` is empty without a key. Request access links carry `data-cta` for click tracking. `scrubEvent` (before_send) cuts the URL fragment, where Telegram puts initData, and person properties from every event
- Mini App at `/app` (`views/app.html`, `{{ANALYTICS}}` filled at startup); `config.web.miniAppUrl` points the View Charts buttons there. PostHog loads only once `/api/user` returns `analytics_id` (the hashed ID, `null` without a key), then identifies and sends `$pageview`, `miniapp_tab_changed`, `miniapp_metric_changed`, `miniapp_day_opened`
- `api.ts` - JSON for the Mini App; changes must be additive, since Telegram caches `app.html`
- `auth.ts` - Telegram initData validation for secure auth

**Analytics** (`src/analytics/`):
- PostHog wrapper (`createAnalytics`); does nothing unless `POSTHOG_API_KEY` is set. Callers pass raw Telegram IDs; only `hashTelegramId` (HMAC with `POSTHOG_ID_SECRET`) leaves the process
- Every event carries `environment` (`POSTHOG_ENVIRONMENT`) because one PostHog project serves prod and testing
- Capturing never throws into the caller; `FakeAnalytics` in `test-helpers.ts` for tests
- Meal text opt-out (`users.analytics_content`, `/settings` → Meal Text Sharing): `withContentPreference` (`content-preference.ts`) wraps the Analytics in `createBot`, dropping prompt/reply/error text from events and the message from exceptions. Report through the Analytics `createBot` returns, not the raw one from `createAnalytics`
- The browser never gets `POSTHOG_ID_SECRET`: `WebServerDeps.analytics` is the browser-safe part, and the secret reaches `/api/user` separately as `analyticsIdSecret`
- Error tracking: `bot.catch` (`src/bot/errors.ts`), process handlers (`src/process-errors.ts`), AI failures in `AIService`, and the jobs. Each error object is reported once, from the first catch that sees it; expected Telegram errors (blocked bot, "message is not modified") are skipped via `isExpectedTelegramError`
- LLM analytics: providers return a `trace` (system + user message, raw reply) and throw `ProviderParseError` (still a `SyntaxError`, with usage and trace) on bad JSON; `AIService.recordSafely()` writes `ai_usage` then sends `$ai_generation` with TeleCal's own cost
- `src/shutdown.ts` handles SIGINT and SIGTERM and awaits the analytics flush before exit
- Decisions and the privacy line: `docs/adr/0001-posthog-integration.md`

**Background Jobs** (`src/jobs/`):
- `reminders.ts` - Daily reminder notifications
- `retry-pending.ts` - Retries failed AI estimations from `pending_entries` table
- `backfill-protein.ts` - Fills `protein_g` on pre-feature rows, 25 descriptions per AI call; run via `/admin backfill-protein`

### State Machine (LogFlow)

The `/log` conversation uses a state machine stored in `conversation_state` table:
- `awaiting_input` - Waiting for food description
- `clarifying` - AI needs more details, stores context for multi-turn
- `confirming` - Shows estimation, awaits yes/no

### Configuration

All config via environment variables (see `.env.example`):
- `TELEGRAM_BOT_TOKEN` - Required
- `ADMIN_USERS` - Comma-separated Telegram IDs for admin access
- AI provider keys (at least one required): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
- Feature flags: `FEATURE_CACHING`, `FEATURE_LOCAL_FOOD_DB`
- PostHog (optional): `POSTHOG_API_KEY`, `POSTHOG_HOST`, `POSTHOG_ID_SECRET` (required with a key), `POSTHOG_ENVIRONMENT`

### Database Tables

- `allowed_users` - Access control allowlist
- `access_requests` - Requests from non-allowlisted users (pending → approved | declined)
- `users` - User preferences (ai_provider, daily_goal, daily_protein_goal, reminder_time, analytics_content)
- `food_logs` / `food_items` - Log sessions and individual items (`calories`, nullable `protein_g`)
- `conversation_state` - Active `/log` conversations
- `pending_entries` - Failed AI calls awaiting retry
- `estimation_cache` - Cached AI responses

## Testing

Tests use Bun's native test runner with in-memory SQLite for isolation:

```typescript
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
```

Test files are co-located with source: `src/**/*.test.ts`

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on martin0x/TeleCal via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

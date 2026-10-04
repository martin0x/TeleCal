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
bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]   # one live API call to verify a provider; --protein exercises the batch call
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
- `conversations/log-flow.ts` - State machine for `/log` flow (awaiting_input → clarifying → confirming)
- `middleware/allowlist.ts` - Access control via allowed_users table

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
- Mini App for viewing charts
- `auth.ts` - Telegram initData validation for secure auth
- Single-page app at `views/app.html`

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

### Database Tables

- `allowed_users` - Access control allowlist
- `users` - User preferences (ai_provider, daily_goal, daily_protein_goal, reminder_time)
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

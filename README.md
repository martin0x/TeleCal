# TeleCal

A Telegram bot for conversational calorie tracking with AI-powered food estimation.

Describe what you ate in natural language, and TeleCal estimates the calories and protein using AI (OpenAI, Anthropic, or Google Gemini).

## Features

- **Conversational logging** - Multi-turn conversations with AI clarification when needed
- **Multiple AI providers** - Choose between OpenAI, Anthropic Claude, or Google Gemini
- **Statistics** - View daily, weekly, and monthly calorie summaries
- **Landing page** - Public page at `/` with a Request access button that deep-links into the bot
- **Mini App** - Interactive charts via Telegram Web App, served at `/app`
- **Daily reminders** - Optional notifications to log meals
- **Estimation caching** - Faster responses for repeated foods
- **Access control** - Allowlist, plus in-bot access requests that admins approve with one tap

## Requirements

- [Bun](https://bun.sh) runtime
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- At least one AI provider API key

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/telecal.git
cd telecal

# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
```

## Configuration

Edit `.env` with your settings:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token

# Admin users (comma-separated Telegram IDs)
ADMIN_USERS=123456789

# AI Providers (at least one required)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...

# Web server for Mini App
APP_URL=http://localhost:3000
PORT=3000

# Feature flags
FEATURE_CACHING=true
FEATURE_LOCAL_FOOD_DB=false
```

## Usage

```bash
# Development (with hot reload)
bun run dev

# Production
bun run start
```

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and command list |
| `/log` | Start logging food |
| `/today` | View today's calories and protein |
| `/week` | View past 7 days |
| `/month` | View past 30 days |
| `/edit` | Edit a logged entry |
| `/delete` | Delete a logged entry |
| `/settings` | Change AI provider, calorie and protein goals, reminders |
| `/pending` | View entries awaiting AI processing |
| `/usage` | View your own AI token usage |
| `/admin` | Manage allowed users and access requests, view AI usage and cost, backfill protein (admin only) |

### Privacy

Food descriptions are sent to whichever AI provider the user has selected in
`/settings` (OpenAI, Anthropic, or Google) to estimate calories and protein.

The one-off `/admin backfill-protein` command sends the descriptions of items logged before protein tracking existed to the **admin's** selected provider, not each user's.

TeleCal disables server-side retention where the provider offers the option —
OpenAI calls are made with `store: false`, so requests are not kept in the
OpenAI organization's logs. Providers may still retain request content
separately for abuse monitoring under their own policies.

Calorie data itself is stored in TeleCal's local SQLite database.

#### Analytics (PostHog)

TeleCal uses [PostHog](https://posthog.com) Cloud (US region) for error
tracking and analytics. Decisions and reasoning are in
[ADR 0001](docs/adr/0001-posthog-integration.md). PostHog receives:

- **Error reports**, with stack traces. They can include message text, for
  example an AI reply that failed to parse.
- **One event per AI call**: the full prompt (including the food description)
  and the AI's output, plus provider, model, token counts, cost and latency.
- **Page views** from the landing page (cookieless) and the Mini App, and
  totals for access requests and approvals.

Users are identified by an HMAC-SHA256 of their Telegram ID, keyed with a
server-side secret (`POSTHOG_ID_SECRET`). Raw Telegram IDs, usernames and names
are never sent, and no person properties are set. Every event carries an
`environment` tag (`production` or `development`).

Existing users were told with a one-time message (`/admin announce-privacy`);
`/start` and the landing page FAQ link to the same summary.

**Deleting a user's data.** On request, run `/admin posthog-id <telegram_id>`
to get the user's PostHog ID, then in PostHog open **People**, search for that
ID, and delete the person. Deleting a person also deletes their events.

### Logging Flow

1. Send `/log` to start a session
2. Describe what you ate (e.g., "2 eggs and toast with butter")
3. AI estimates calories and protein and may ask clarifying questions
4. Tap **✅ Log** to save it, or **✏️ Change** to describe it again (typing "yes" / "no" also works)
5. Tap **✖️ Cancel**, or send "cancel" at any point, to exit

## Landing page assets

`src/web/public/` holds the landing page's images. To regenerate them (macOS, needs Google Chrome):

1. Put raw phone screenshots in `scripts/screenshots/` as `shot-log`, `shot-today` and `shot-charts` (any image format).
2. Run `bash scripts/build-landing-assets.sh`. It renders `og.png` from `scripts/og.html` and writes 720 px JPEGs.
3. Commit the files in `src/web/public/`.

## Testing

```bash
# Run all tests
bun test

# Run tests in a specific directory
bun test src/ai

# Run a specific test file
bun test src/db/repositories/users.test.ts
```

## Project Structure

```
src/
├── index.ts          # Entry point
├── config.ts         # Environment configuration
├── bot/              # Telegram bot
│   ├── commands/     # Command handlers
│   ├── conversations/# Log flow state machine
│   └── middleware/   # Allowlist access control
├── ai/               # AI service layer
│   ├── service.ts    # Provider abstraction
│   └── providers/    # OpenAI, Anthropic, Gemini
├── db/               # SQLite database
│   ├── schema.sql    # Database schema
│   └── repositories/ # Data access layer
├── web/              # Landing page and Mini App web server
│   ├── server.ts     # Bun HTTP server
│   ├── auth.ts       # Telegram auth validation
│   ├── public/       # Landing page images (served at /assets/*)
│   └── views/        # landing.html, app.html
└── jobs/             # Background jobs
    ├── reminders.ts  # Daily notifications
    └── retry-pending.ts # Retry failed AI calls
```

## License

MIT

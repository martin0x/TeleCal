# TeleCal

A Telegram bot for conversational calorie tracking with AI-powered food estimation.

Describe what you ate in natural language, and TeleCal estimates the calories using AI (OpenAI, Anthropic, or Google Gemini).

## Features

- **Conversational logging** - Multi-turn conversations with AI clarification when needed
- **Multiple AI providers** - Choose between OpenAI, Anthropic Claude, or Google Gemini
- **Statistics** - View daily, weekly, and monthly calorie summaries
- **Mini App** - Interactive charts via Telegram Web App
- **Daily reminders** - Optional notifications to log meals
- **Estimation caching** - Faster responses for repeated foods
- **Access control** - Allowlist system for private use

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
| `/today` | View today's calories |
| `/week` | View past 7 days |
| `/month` | View past 30 days |
| `/edit` | Edit a logged entry |
| `/delete` | Delete a logged entry |
| `/settings` | Change AI provider, daily goal, reminders |
| `/pending` | View entries awaiting AI processing |
| `/admin` | Manage allowed users (admin only) |

### Logging Flow

1. Send `/log` to start a session
2. Describe what you ate (e.g., "2 eggs and toast with butter")
3. AI estimates calories and may ask clarifying questions
4. Confirm with "yes" or retry with "no"
5. Send "cancel" at any point to exit

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
├── web/              # Mini App web server
│   ├── server.ts     # Bun HTTP server
│   ├── auth.ts       # Telegram auth validation
│   └── views/        # Frontend
└── jobs/             # Background jobs
    ├── reminders.ts  # Daily notifications
    └── retry-pending.ts # Retry failed AI calls
```

## License

MIT

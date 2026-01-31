# TeleCal Design Document

A Telegram bot for conversational calorie tracking with AI-powered estimation.

## Overview

TeleCal allows users to track calories individually or in group chats with social accountability. Food logging is conversational — the AI asks clarifying questions and confirms before logging. Statistics are displayed as text summaries with optional interactive charts via Telegram Mini App.

## Tech Stack

- **Runtime:** Bun
- **Bot framework:** grammy
- **Database:** SQLite (bun:sqlite)
- **AI providers:** OpenAI, Anthropic (user-selectable)
- **Mini App:** Vanilla JS + Chart.js
- **Deployment:** Containerized (Fly.io or Railway)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Bun Server                         │
├─────────────────────────────────────────────────────┤
│  Telegram Bot          │    Web Server              │
│  (grammy)              │    (Bun.serve)             │
│                        │                            │
│  • Command handlers    │    • GET /app → Mini App   │
│  • AI conversations    │    • GET /api/stats/:id    │
│  • Sends button links  │    • Serves chart data     │
├─────────────────────────────────────────────────────┤
│              AI Service Layer                        │
│    (OpenAI, Anthropic — per user preference)        │
├─────────────────────────────────────────────────────┤
│              Data Layer (SQLite)                     │
│    Users │ FoodLogs │ FoodItems │ ConversationState │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Conversation state in DB** — The `/log` command is multi-turn. State survives bot restarts.
2. **User identity** — Telegram's `user.id` as primary identifier. Works in DMs and groups.
3. **Group visibility** — Logs in groups are visible to all members (social accountability).
4. **AI abstraction** — Simple interface all providers implement.
5. **Allowlist access** — Only pre-approved users can use the bot.

---

## Database Schema

```sql
-- Allowed users (access control)
allowed_users (
  telegram_id    INTEGER PRIMARY KEY,
  added_by       INTEGER,
  added_at       DATETIME
)

-- Users and their preferences
users (
  telegram_id    INTEGER PRIMARY KEY,
  username       TEXT,
  ai_provider    TEXT DEFAULT 'openai',
  daily_goal     INTEGER,
  reminder_time  TEXT,              -- e.g., "21:00"
  reminder_mention BOOLEAN DEFAULT true,
  created_at     DATETIME
)

-- Food log entries (one per /log session)
food_logs (
  id             INTEGER PRIMARY KEY,
  telegram_id    INTEGER,
  chat_id        INTEGER,
  logged_at      DATETIME,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
)

-- Individual food items within a log
food_items (
  id             INTEGER PRIMARY KEY,
  log_id         INTEGER,
  description    TEXT,
  calories       INTEGER,
  emoji          TEXT,
  FOREIGN KEY (log_id) REFERENCES food_logs(id)
)

-- Active conversations for /log flow
conversation_state (
  telegram_id    INTEGER PRIMARY KEY,
  chat_id        INTEGER,
  state          TEXT,              -- 'awaiting_input' | 'clarifying' | 'confirming'
  pending_food   TEXT,
  pending_items  TEXT,              -- JSON array of items
  context        TEXT,              -- JSON: clarification history
  updated_at     DATETIME
)

-- Entries waiting for AI processing
pending_entries (
  id             INTEGER PRIMARY KEY,
  telegram_id    INTEGER,
  chat_id        INTEGER,
  food_text      TEXT,
  submitted_at   DATETIME,
  target_date    DATE,
  retry_count    INTEGER DEFAULT 0,
  last_retry_at  DATETIME
)
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/log [date]` | Start conversational food logging |
| `/today` | Show today's calories and entries |
| `/week` | Show past 7 days breakdown |
| `/month` | Show past 30 days summary |
| `/edit [date]` | Modify a food item |
| `/delete [date]` | Remove food item(s) |
| `/settings` | Change provider, goal, reminders |
| `/pending` | View entries waiting for AI |
| `/admin` | Manage allowlist (admins only) |

---

## /log Conversation Flow

### Example Flow

```
User: /log
Bot:  What did you eat?

User: some chicken and rice
Bot:  A few questions:
      • How much chicken? (e.g., 100g, 1 breast, a handful)
      • Was the rice white or brown, and roughly how much?

User: grilled chicken breast, about 1 cup of white rice
Bot:  Got it! Here's what I'll log:

      🍗 Grilled chicken breast — 165 cal
      🍚 White rice (1 cup) — 205 cal
      ─────────────────
      Total: 370 cal

      Log this? (yes/no)

User: yes
Bot:  ✓ Logged 370 calories
```

### Flow States

1. **awaiting_input** — Bot asked "What did you eat?", waiting for response
2. **clarifying** — AI needs more details, asked follow-up questions
3. **confirming** — AI has estimates, waiting for yes/no
4. **done** — Logged or cancelled, state cleared

### Key Behaviors

- Any non-command message continues the active conversation
- User can type "cancel" at any point to abort
- Timeout after 10 minutes of inactivity (state cleared)
- If user starts `/log` while one is active, show current state and ask to continue or start over

### Date Support

```
/log                → today
/log yesterday      → yesterday
/log jan 29         → January 29 (current year)
/log 2025-01-29     → explicit date
```

**Date parsing rules:**
1. `jan 29` → current year by default
2. If that date is in the future → use previous year + notify user
3. Explicit year always respected

---

## Statistics Display

### /today

```
📊 Today (Jan 31)

🍳 Scrambled eggs (2) — 180 cal
🍞 Toast with butter — 120 cal
🍗 Grilled chicken breast — 165 cal
🍚 White rice (1 cup) — 205 cal
─────────────────
Total: 670 / 1,800 cal (37%)
████████░░░░░░░░░░░░░░
```

### /week

```
📊 Past 7 days

Sat 25  ████████████░░░░  1,850 cal
Sun 26  ██████████████░░  2,100 cal
Mon 27  ███████████░░░░░  1,650 cal
Tue 28  █████████████░░░  1,920 cal
Wed 29  ██████████████░░  2,050 cal
Thu 30  ████████████░░░░  1,780 cal
Fri 31  ████░░░░░░░░░░░░    670 cal (today)
─────────────────
Avg: 1,717 cal/day

[View Details ↗]
```

### /month

```
📊 Past 30 days

Week 1 (Jan 1-7)   — avg 1,820 cal/day
Week 2 (Jan 8-14)  — avg 1,950 cal/day
Week 3 (Jan 15-21) — avg 1,780 cal/day
Week 4 (Jan 22-28) — avg 1,850 cal/day
This week          — avg 1,717 cal/day
─────────────────
Monthly avg: 1,830 cal/day

[View Details ↗]
```

---

## Mini App (Interactive Charts)

### Architecture

The Mini App is served by the same Bun server and opens inside Telegram when user taps "View Details" button.

```
User taps [View Details ↗]
      ↓
Mini App opens inside Telegram
      ↓
┌─────────────────────────┐
│  📊 Your Week           │
│  ┌───────────────────┐  │
│  │    ▁ ▃ █ ▅ ▂ ▇ ▄  │  │  ← Interactive chart
│  │   M T W T F S S   │  │
│  └───────────────────┘  │
│                         │
│  Tap a day for details  │
│                         │
│  Total: 12,019 cal      │
│  Average: 1,717 cal/day │
└─────────────────────────┘
```

### Tech Stack

- Single HTML file with vanilla JS
- Chart.js for interactive charts
- Telegram Web App SDK for theme colors + user auth
- Data fetched from `/api/stats/:userId`

---

## AI Service Layer

### Provider Interface

```typescript
interface AIProvider {
  estimateCalories(
    food: string,
    context?: string
  ): Promise<{
    items: { description: string, calories: number, emoji: string }[],
    needsClarification: boolean,
    clarificationQuestions?: string[],
    confidence: number
  }>
}
```

### Pipeline Architecture

```typescript
const config = {
  features: {
    caching: true,        // Toggle off if causing issues
    localFoodDb: true,    // Toggle off if not effective
  }
}

async function estimateCalories(food: string, userId: string) {
  const provider = getUserProvider(userId)

  // Step 1: Check cache (skipped if disabled)
  if (config.features.caching) {
    const cached = await cache.get(normalize(food))
    if (cached) return cached
  }

  // Step 2: Check local DB (skipped if disabled)
  if (config.features.localFoodDb) {
    const local = await foodDb.lookup(food)
    if (local) return { ...local, confidence: 1.0 }
  }

  // Step 3: AI estimation (always runs if above miss)
  const result = await provider.estimateCalories(food)

  // Cache high-confidence results
  if (config.features.caching && result.confidence > 0.8) {
    await cache.set(normalize(food), result)
  }

  return result
}
```

### Key Features

- **Caching:** Common foods cached to reduce API calls (toggleable)
- **Local food DB:** USDA database for exact matches (toggleable)
- **Confidence scores:** Low confidence triggers more clarification
- **Web search:** Provider implementations can use web search for accuracy
- **Structured output:** JSON mode for reliable parsing

---

## Edit and Delete Commands

### /delete

```
User: /delete
Bot:  📋 Today's entries:

      1. 🍳 Scrambled eggs (2) — 180 cal
      2. 🍞 Toast with butter — 120 cal
      3. 🍗 Grilled chicken breast — 165 cal

      What to delete?
      • Enter a number to delete one item
      • "all" to delete everything
      • "cancel" to abort

User: all
Bot:  ⚠️ Delete all 3 entries for today? (465 cal total)
      Type "yes" to confirm

User: yes
Bot:  ✓ Deleted all entries for today
```

### /edit

```
User: /edit
Bot:  📋 Today's entries:

      1. 🍳 Scrambled eggs (2) — 180 cal
      2. 🍞 Toast with butter — 120 cal

      Which item to edit? (enter number or "cancel")

User: 1
Bot:  Editing: 🍳 Scrambled eggs (2) — 180 cal

      What would you like to change?
      • Type new description (re-estimates calories)
      • Type a number to set calories manually

User: 140
Bot:  ✓ Updated: Scrambled eggs (2) — 140 cal
```

---

## Settings

### /settings

```
⚙️ Your Settings

AI Provider: OpenAI ✓
Daily Goal: 1,800 cal
Reminder: 9:00 PM (mention: on)

[Change Provider]  [Set Daily Goal]
[Set Reminder]     [Cancel]
```

### Provider Selection

```
⚙️ Select AI Provider

[OpenAI ✓]  [Anthropic]

[← Back]
```

### Reminder Settings

```
⏰ Reminder Settings

When should I remind you to log?
Enter a time (e.g., "8pm", "20:00"), or "off" to disable
```

### Reminder Behavior

```
9:00 PM (mention on, no logs today):
@john Haven't seen any logs today! 🍽️
Current: 0 cal | Goal: 1,800 cal

9:00 PM (mention on, has logs):
@john Daily check-in 🍽️
Current: 1,200 / 1,800 cal — keep it up!
```

---

## Access Control

### Allowlist

Only users in the allowlist can use the bot. Admins are defined in environment variables and can manage the allowlist at runtime.

```bash
# .env
ADMIN_USERS=123456789,987654321
```

### Admin Commands

```
/admin add @username     → adds user to allowlist
/admin remove @username  → removes user
/admin list              → shows all allowed users
```

### Non-Allowed User Experience

```
User: /log
Bot:  ⛔ Sorry, this bot is invite-only.
      Contact the admin to request access.
```

---

## Error Handling

### AI Provider Failures

When AI is unavailable, entries are saved for later processing:

```
User: grilled salmon with vegetables

Bot:  ⚠️ Couldn't reach AI right now. I've saved your entry —
      I'll estimate and notify you when it's ready.

      You can check pending entries with /pending
```

### /pending Command

```
📋 Pending entries:

1. "grilled salmon with vegetables"
   Submitted: Jan 30, 8:15 PM → will log to Jan 30

2. "oatmeal with banana"
   Submitted: Jan 31, 7:30 AM → will log to Jan 31

[Cancel All]  [Retry Now]
```

### When AI Recovers

```
✅ Your saved entry from Jan 30 is ready!

🐟 Grilled salmon — 280 cal
🥗 Mixed vegetables — 85 cal
───────────────
Total: 365 cal

Log this to Jan 30? (yes/no)
```

### General Principles

- Always give the user a next step
- Never show technical errors (log server-side)
- Timeout gracefully (conversation expires after 10 min)

---

## Project Structure

```
telecal/
├── src/
│   ├── index.ts              # Entry point — starts bot + web server
│   ├── config.ts             # Feature flags, env vars, constants
│   │
│   ├── bot/
│   │   ├── index.ts          # Bot setup, middleware, command registration
│   │   ├── commands/
│   │   │   ├── log.ts        # /log conversation handler
│   │   │   ├── today.ts      # /today stats
│   │   │   ├── week.ts       # /week stats
│   │   │   ├── month.ts      # /month stats
│   │   │   ├── edit.ts       # /edit handler
│   │   │   ├── delete.ts     # /delete handler
│   │   │   ├── settings.ts   # /settings handler
│   │   │   ├── pending.ts    # /pending handler
│   │   │   └── admin.ts      # /admin handler
│   │   └── conversations/
│   │       └── log-flow.ts   # State machine for /log conversation
│   │
│   ├── ai/
│   │   ├── index.ts          # Provider factory, pipeline
│   │   ├── types.ts          # AIProvider interface
│   │   ├── providers/
│   │   │   ├── openai.ts
│   │   │   └── anthropic.ts
│   │   ├── cache.ts          # Food estimation cache
│   │   └── food-db.ts        # Local USDA database lookup
│   │
│   ├── db/
│   │   ├── index.ts          # SQLite connection (bun:sqlite)
│   │   ├── schema.sql        # Table definitions
│   │   ├── migrations/       # Future schema changes
│   │   └── repositories/
│   │       ├── users.ts
│   │       ├── food-logs.ts
│   │       ├── pending.ts
│   │       ├── allowed-users.ts
│   │       └── conversations.ts
│   │
│   ├── web/
│   │   ├── index.ts          # Bun.serve setup, routes
│   │   └── api/
│   │       └── stats.ts      # GET /api/stats/:userId
│   │
│   └── jobs/
│       ├── reminders.ts      # Scheduled reminder checks
│       └── retry-pending.ts  # Retry failed AI estimations
│
├── webapp/                   # Mini App (served as static files)
│   ├── index.html
│   ├── app.js
│   └── styles.css
│
├── data/
│   ├── telecal.db            # SQLite database file
│   └── usda-foods.json       # Local food database (optional)
│
├── .env.example              # Environment variables template
├── package.json
└── README.md
```

---

## Configuration

### .env.example

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token

# Access control
ADMIN_USERS=123456789,987654321

# AI Providers (shared keys)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Web server (for Mini App)
APP_URL=https://your-domain.com
PORT=3000

# Feature flags
FEATURE_CACHING=true
FEATURE_LOCAL_FOOD_DB=true

# Timing
REMINDER_CHECK_INTERVAL=60000
PENDING_RETRY_INTERVAL=300000
CONVERSATION_TIMEOUT=600000
```

### Security Considerations

- Bot token and API keys never logged or exposed
- User data scoped by `telegram_id`
- Mini App validates user via Telegram's `initData` signature
- Rate limiting per user to prevent abuse
- Allowlist restricts access to approved users only

---

## Testing Strategy

### Unit Tests

```
src/
├── ai/
│   ├── cache.test.ts         # Cache hit/miss, expiration
│   ├── food-db.test.ts       # Local DB lookups
│   └── providers/
│       └── openai.test.ts    # Mock API, parse responses
├── db/repositories/
│   ├── users.test.ts         # CRUD operations
│   └── food-logs.test.ts     # Log queries, aggregations
└── bot/conversations/
    └── log-flow.test.ts      # State transitions
```

### Integration Tests

```typescript
test("log flow with clarification", async () => {
  mockAI.setResponse({ needsClarification: true, questions: ["How much?"] })

  await bot.handleMessage("/log")
  await bot.handleMessage("chicken")

  expect(lastReply).toContain("How much?")

  await bot.handleMessage("200g grilled")
  await bot.handleMessage("yes")

  expect(db.foodLogs.count()).toBe(1)
})
```

### Test Coverage Priorities

| Area | Priority | Approach |
|------|----------|----------|
| AI response parsing | High | Unit tests with mock responses |
| Conversation state machine | High | Unit tests for each transition |
| DB queries (stats) | Medium | Integration with test DB |
| Date parsing | Medium | Unit tests for edge cases |
| Telegram message formatting | Low | Snapshot tests |

---

## Deployment

### Containerized (Recommended)

```dockerfile
FROM oven/bun:latest
COPY . /app
WORKDIR /app
RUN bun install
CMD ["bun", "run", "src/index.ts"]
```

### Platform Options

- **Fly.io** or **Railway** (both work well with Bun)
- Persistent volume required for SQLite (attach to `/data`)
- Use paid tier to avoid cold starts (reminders need always-on)
- Deploy via GitHub integration for auto-deploy

### Estimated Cost

~$5-8/month for containerized deployment with persistent storage.

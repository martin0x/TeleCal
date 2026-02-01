# Mini App Design

> **Goal:** Data visualization Mini App for TeleCal - interactive charts showing weekly/monthly calorie trends, goal progress, and daily food logs.

## Architecture

The Mini App is a single-page web application served by Bun's built-in HTTP server. It runs alongside the bot in the same process, sharing database access.

### Server Structure

```
src/web/
├── server.ts        # Bun.serve() setup, routes
├── auth.ts          # Telegram initData validation
├── api.ts           # JSON endpoints for chart data
└── views/
    └── app.html     # Single HTML file with embedded CSS/JS
```

### Routes

| Route | Purpose |
|-------|---------|
| `GET /` | Serves the Mini App HTML |
| `GET /api/user` | Returns user settings (daily goal) |
| `GET /api/today` | Returns today's entries and total |
| `GET /api/stats` | Returns weekly/monthly calorie data |
| `GET /api/day/:date` | Returns entries for a specific date |

### Technology Choices

- **Chart.js via CDN** - Lightweight, mobile-friendly, no build step
- **Telegram initData validation** - Seamless auth via HMAC signature
- **Single HTML file** - Embedded CSS/JS, served directly by Bun

---

## Frontend UI

### Layout

Single scrollable page optimized for mobile with three tabs.

```
┌─────────────────────────┐
│  [Today] [Week] [Month] │  ← Tab navigation
├─────────────────────────┤
│                         │
│     ◯ 1,450 / 2,000     │  ← Progress ring (today)
│        72% of goal      │
│                         │
├─────────────────────────┤
│  Today's Log            │
│  🍳 Eggs & toast    320 │  ← Scrollable list
│  🍕 Pizza slice     285 │
└─────────────────────────┘
```

### Tab Views

**Today Tab:**
- Progress ring (doughnut chart) showing calories vs goal
- List of today's food entries

**Week Tab:**
- Vertical bar chart with 7 bars
- Goal line overlay
- Tap any bar to show that day's food log below

**Month Tab:**
- Line chart showing 30-day trend (view only)
- Calendar grid below for day selection
- Tap any day to show that day's food log

```
┌─────────────────────────┐
│     📈 Monthly Trend    │
│   ╱╲    ╱╲              │
├─────────────────────────┤
│  M  T  W  T  F  S  S    │
│  ·  ·  1  2  3  4  5    │  ← Dots = no data
│  6  7  8  9  10 11 12   │     Numbers = has entries
│  13 14 15 16 17 ●  19   │     ● = selected day
│  20 21 22 23 24 25 26   │
│  27 28 29 30 31 ·  ·    │
├─────────────────────────┤
│  Saturday, Jan 17       │
│  🍳 Breakfast      450  │
│  🍕 Lunch          620  │
└─────────────────────────┘
```

### Styling

- Uses Telegram's theme variables (`var(--tg-theme-bg-color)`, etc.)
- No external CSS frameworks - embedded styles only
- Responsive: works on any phone width
- Dark/light mode automatic via Telegram theme

---

## API Endpoints

### GET /api/user

```json
{
  "daily_goal": 2000,
  "username": "john"
}
```

### GET /api/today

```json
{
  "date": "2026-02-01",
  "total": 1450,
  "items": [
    { "id": 12, "description": "Eggs & toast", "calories": 320, "emoji": "🍳" },
    { "id": 13, "description": "Pizza slice", "calories": 285, "emoji": "🍕" }
  ]
}
```

### GET /api/stats?period=week|month

```json
{
  "start": "2026-01-26",
  "end": "2026-02-01",
  "daily": {
    "2026-01-26": 1820,
    "2026-01-27": 0,
    "2026-01-28": 2100
  }
}
```

### GET /api/day/:date

```json
{
  "date": "2026-01-15",
  "total": 1650,
  "items": [
    { "id": 8, "description": "Breakfast", "calories": 450, "emoji": "🍳" },
    { "id": 9, "description": "Lunch", "calories": 620, "emoji": "🍕" }
  ]
}
```

---

## Authentication

### Telegram initData Validation

When Telegram opens a Mini App, it passes signed user data:

```
query_id=AAHdF6IQ...
user={"id":123456789,"first_name":"John",...}
auth_date=1234567890
hash=abc123...
```

### Validation Algorithm

```typescript
function validateInitData(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  params.delete("hash")

  // Sort and create data check string
  const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join("\n")

  // Validate HMAC
  const secret = hmacSHA256("WebAppData", botToken)
  const expectedHash = hmacSHA256(dataCheckString, secret)

  if (hash !== expectedHash) return null

  const user = JSON.parse(params.get("user") || "{}")
  return user
}
```

### Frontend Authorization

```javascript
const initData = window.Telegram.WebApp.initData

fetch('/api/stats?period=week', {
  headers: { 'Authorization': `tg-init-data ${initData}` }
})
```

---

## Bot Integration

### Inline Button to Launch Mini App

```typescript
await ctx.reply("📊 Today's calories: 1,450", {
  reply_markup: {
    inline_keyboard: [[
      { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
    ]]
  }
})
```

### Menu Button (Optional)

```typescript
await bot.api.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "📊 Charts",
    web_app: { url: config.web.appUrl }
  }
})
```

---

## Implementation Tasks

### Task 9.1: Web Server Foundation
- Create `src/web/server.ts` with Bun.serve()
- Create `src/web/auth.ts` with initData validation
- Create `src/web/api.ts` with route handlers
- Wire into `src/index.ts`

### Task 9.2: API Endpoints
- Implement GET /api/user
- Implement GET /api/today
- Implement GET /api/stats
- Implement GET /api/day/:date

### Task 9.3: Mini App Frontend
- Create `src/web/views/app.html`
- Implement tab navigation
- Implement Today view with progress ring
- Implement Week view with bar chart
- Implement Month view with line chart + calendar
- Implement day selection and food log display

### Task 9.4: Bot Integration
- Add "View Charts" button to /today, /week, /month commands
- Test end-to-end flow

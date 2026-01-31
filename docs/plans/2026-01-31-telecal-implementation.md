# TeleCal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Telegram bot for conversational calorie tracking with AI-powered estimation.

**Architecture:** Bun server running grammy bot + web server. SQLite for persistence. AI providers (OpenAI/Anthropic) for calorie estimation. Mini App for interactive charts.

**Tech Stack:** Bun, grammy, bun:sqlite, OpenAI SDK, Anthropic SDK, Chart.js

---

## Phase 1: Project Foundation

### Task 1.1: Initialize Bun Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "telecal",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "grammy": "^1.21.1",
    "openai": "^4.67.0",
    "@anthropic-ai/sdk": "^0.30.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"]
}
```

**Step 3: Create .env.example**

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token

# Access control
ADMIN_USERS=123456789

# AI Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Web server
APP_URL=http://localhost:3000
PORT=3000

# Feature flags
FEATURE_CACHING=true
FEATURE_LOCAL_FOOD_DB=false

# Timing (ms)
REMINDER_CHECK_INTERVAL=60000
PENDING_RETRY_INTERVAL=300000
CONVERSATION_TIMEOUT=600000
```

**Step 4: Create minimal src/index.ts**

```typescript
console.log("TeleCal starting...")
```

**Step 5: Install dependencies**

Run: `bun install`
Expected: Dependencies installed, bun.lockb created

**Step 6: Verify project runs**

Run: `bun run src/index.ts`
Expected: "TeleCal starting..." printed

**Step 7: Commit**

```bash
git add package.json tsconfig.json .env.example src/index.ts bun.lockb
git commit -m "feat: initialize bun project with dependencies"
```

---

### Task 1.2: Create Config Module

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config.test.ts
import { describe, test, expect, beforeEach } from "bun:test"

describe("config", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.ADMIN_USERS = "123,456"
    process.env.PORT = "3000"
  })

  test("loads telegram bot token", async () => {
    const { config } = await import("./config")
    expect(config.telegram.botToken).toBe("test-token")
  })

  test("parses admin users as array of numbers", async () => {
    const { config } = await import("./config")
    expect(config.adminUsers).toEqual([123, 456])
  })

  test("loads feature flags with defaults", async () => {
    const { config } = await import("./config")
    expect(config.features.caching).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/config.ts
function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key]
  return value ? parseInt(value, 10) : defaultValue
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (value === undefined) return defaultValue
  return value.toLowerCase() === "true"
}

function getEnvArray(key: string, defaultValue: number[] = []): number[] {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.split(",").map((s) => parseInt(s.trim(), 10))
}

export const config = {
  telegram: {
    botToken: getEnv("TELEGRAM_BOT_TOKEN"),
  },
  adminUsers: getEnvArray("ADMIN_USERS"),
  ai: {
    openaiApiKey: getEnv("OPENAI_API_KEY", ""),
    anthropicApiKey: getEnv("ANTHROPIC_API_KEY", ""),
  },
  web: {
    appUrl: getEnv("APP_URL", "http://localhost:3000"),
    port: getEnvNumber("PORT", 3000),
  },
  features: {
    caching: getEnvBoolean("FEATURE_CACHING", true),
    localFoodDb: getEnvBoolean("FEATURE_LOCAL_FOOD_DB", false),
  },
  timing: {
    reminderCheckInterval: getEnvNumber("REMINDER_CHECK_INTERVAL", 60000),
    pendingRetryInterval: getEnvNumber("PENDING_RETRY_INTERVAL", 300000),
    conversationTimeout: getEnvNumber("CONVERSATION_TIMEOUT", 600000),
  },
}

export type Config = typeof config
```

**Step 4: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config module with env parsing"
```

---

## Phase 2: Database Layer

### Task 2.1: SQLite Connection

**Files:**
- Create: `src/db/index.ts`
- Create: `src/db/schema.sql`
- Create: `data/.gitkeep`

**Step 1: Create schema.sql**

```sql
-- src/db/schema.sql

-- Allowed users (access control)
CREATE TABLE IF NOT EXISTS allowed_users (
  telegram_id INTEGER PRIMARY KEY,
  added_by INTEGER,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Users and their preferences
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  ai_provider TEXT DEFAULT 'openai',
  daily_goal INTEGER,
  reminder_time TEXT,
  reminder_mention INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Food log entries (one per /log session)
CREATE TABLE IF NOT EXISTS food_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  logged_at TEXT DEFAULT (datetime('now')),
  target_date TEXT NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Individual food items within a log
CREATE TABLE IF NOT EXISTS food_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  calories INTEGER NOT NULL,
  emoji TEXT,
  FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
);

-- Active conversations for /log flow
CREATE TABLE IF NOT EXISTS conversation_state (
  telegram_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  pending_food TEXT,
  pending_items TEXT,
  context TEXT,
  target_date TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Entries waiting for AI processing
CREATE TABLE IF NOT EXISTS pending_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  food_text TEXT NOT NULL,
  submitted_at TEXT DEFAULT (datetime('now')),
  target_date TEXT NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TEXT
);

-- Cache for AI estimations
CREATE TABLE IF NOT EXISTS estimation_cache (
  normalized_food TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Step 2: Create database module**

```typescript
// src/db/index.ts
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"

const DB_PATH = process.env.DB_PATH ?? "data/telecal.db"

export const db = new Database(DB_PATH, { create: true })

// Enable foreign keys
db.run("PRAGMA foreign_keys = ON")

export function initializeDatabase(): void {
  const schemaPath = join(import.meta.dir, "schema.sql")
  const schema = readFileSync(schemaPath, "utf-8")
  db.run(schema)
}

export function closeDatabase(): void {
  db.close()
}
```

**Step 3: Create data directory placeholder**

```bash
mkdir -p data
touch data/.gitkeep
```

**Step 4: Commit**

```bash
git add src/db/index.ts src/db/schema.sql data/.gitkeep
git commit -m "feat: add SQLite database with schema"
```

---

### Task 2.2: Users Repository

**Files:**
- Create: `src/db/repositories/users.ts`
- Test: `src/db/repositories/users.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db/repositories/users.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { UsersRepository, User } from "./users"

describe("UsersRepository", () => {
  let db: Database
  let repo: UsersRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        ai_provider TEXT DEFAULT 'openai',
        daily_goal INTEGER,
        reminder_time TEXT,
        reminder_mention INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new UsersRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates a new user", () => {
    const user = repo.upsert(123, "john")
    expect(user.telegram_id).toBe(123)
    expect(user.username).toBe("john")
    expect(user.ai_provider).toBe("openai")
  })

  test("updates existing user", () => {
    repo.upsert(123, "john")
    const user = repo.upsert(123, "johnny")
    expect(user.username).toBe("johnny")
  })

  test("finds user by telegram_id", () => {
    repo.upsert(123, "john")
    const user = repo.findById(123)
    expect(user?.username).toBe("john")
  })

  test("returns null for non-existent user", () => {
    const user = repo.findById(999)
    expect(user).toBeNull()
  })

  test("updates user settings", () => {
    repo.upsert(123, "john")
    repo.updateSettings(123, { daily_goal: 2000, ai_provider: "anthropic" })
    const user = repo.findById(123)
    expect(user?.daily_goal).toBe(2000)
    expect(user?.ai_provider).toBe("anthropic")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db/repositories/users.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/db/repositories/users.ts
import { Database } from "bun:sqlite"

export interface User {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  reminder_time: string | null
  reminder_mention: boolean
  created_at: string
}

interface UserRow {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  reminder_time: string | null
  reminder_mention: number
  created_at: string
}

export class UsersRepository {
  constructor(private db: Database) {}

  upsert(telegramId: number, username?: string): User {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_id, username)
      VALUES (?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username)
      RETURNING *
    `)
    const row = stmt.get(telegramId, username ?? null) as UserRow
    return this.rowToUser(row)
  }

  findById(telegramId: number): User | null {
    const stmt = this.db.prepare("SELECT * FROM users WHERE telegram_id = ?")
    const row = stmt.get(telegramId) as UserRow | null
    return row ? this.rowToUser(row) : null
  }

  updateSettings(
    telegramId: number,
    settings: Partial<{
      ai_provider: string
      daily_goal: number | null
      reminder_time: string | null
      reminder_mention: boolean
    }>
  ): void {
    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (settings.ai_provider !== undefined) {
      updates.push("ai_provider = ?")
      values.push(settings.ai_provider)
    }
    if (settings.daily_goal !== undefined) {
      updates.push("daily_goal = ?")
      values.push(settings.daily_goal)
    }
    if (settings.reminder_time !== undefined) {
      updates.push("reminder_time = ?")
      values.push(settings.reminder_time)
    }
    if (settings.reminder_mention !== undefined) {
      updates.push("reminder_mention = ?")
      values.push(settings.reminder_mention ? 1 : 0)
    }

    if (updates.length === 0) return

    values.push(telegramId)
    const sql = `UPDATE users SET ${updates.join(", ")} WHERE telegram_id = ?`
    this.db.run(sql, ...values)
  }

  private rowToUser(row: UserRow): User {
    return {
      ...row,
      reminder_mention: row.reminder_mention === 1,
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db/repositories/users.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/users.ts src/db/repositories/users.test.ts
git commit -m "feat: add users repository with CRUD operations"
```

---

### Task 2.3: Allowed Users Repository

**Files:**
- Create: `src/db/repositories/allowed-users.ts`
- Test: `src/db/repositories/allowed-users.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db/repositories/allowed-users.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { AllowedUsersRepository } from "./allowed-users"

describe("AllowedUsersRepository", () => {
  let db: Database
  let repo: AllowedUsersRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE allowed_users (
        telegram_id INTEGER PRIMARY KEY,
        added_by INTEGER,
        added_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new AllowedUsersRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("adds user to allowlist", () => {
    repo.add(123, 999)
    expect(repo.isAllowed(123)).toBe(true)
  })

  test("checks if user is allowed", () => {
    expect(repo.isAllowed(123)).toBe(false)
    repo.add(123, 999)
    expect(repo.isAllowed(123)).toBe(true)
  })

  test("removes user from allowlist", () => {
    repo.add(123, 999)
    repo.remove(123)
    expect(repo.isAllowed(123)).toBe(false)
  })

  test("lists all allowed users", () => {
    repo.add(123, 999)
    repo.add(456, 999)
    const users = repo.listAll()
    expect(users.length).toBe(2)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db/repositories/allowed-users.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/db/repositories/allowed-users.ts
import { Database } from "bun:sqlite"

export interface AllowedUser {
  telegram_id: number
  added_by: number | null
  added_at: string
}

export class AllowedUsersRepository {
  constructor(private db: Database) {}

  add(telegramId: number, addedBy: number): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO allowed_users (telegram_id, added_by)
      VALUES (?, ?)
    `)
    stmt.run(telegramId, addedBy)
  }

  remove(telegramId: number): void {
    const stmt = this.db.prepare("DELETE FROM allowed_users WHERE telegram_id = ?")
    stmt.run(telegramId)
  }

  isAllowed(telegramId: number): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM allowed_users WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) !== null
  }

  listAll(): AllowedUser[] {
    const stmt = this.db.prepare("SELECT * FROM allowed_users ORDER BY added_at")
    return stmt.all() as AllowedUser[]
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db/repositories/allowed-users.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/allowed-users.ts src/db/repositories/allowed-users.test.ts
git commit -m "feat: add allowed-users repository for access control"
```

---

### Task 2.4: Food Logs Repository

**Files:**
- Create: `src/db/repositories/food-logs.ts`
- Test: `src/db/repositories/food-logs.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db/repositories/food-logs.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { FoodLogsRepository, FoodItem } from "./food-logs"

describe("FoodLogsRepository", () => {
  let db: Database
  let repo: FoodLogsRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.run(`
      CREATE TABLE food_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        logged_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE food_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        calories INTEGER NOT NULL,
        emoji TEXT,
        FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
      )
    `)
    repo = new FoodLogsRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates log with items", () => {
    const items: FoodItem[] = [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ]
    const log = repo.create(123, 456, "2026-01-31", items)
    expect(log.id).toBeDefined()
    expect(log.items.length).toBe(2)
  })

  test("gets entries for a specific date", () => {
    const items = [{ description: "Eggs", calories: 180, emoji: "🍳" }]
    repo.create(123, 456, "2026-01-31", items)
    repo.create(123, 456, "2026-01-30", items)

    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries.length).toBe(1)
  })

  test("calculates total calories for a date", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ])
    const total = repo.getTotalCalories(123, "2026-01-31")
    expect(total).toBe(300)
  })

  test("gets daily totals for date range", () => {
    repo.create(123, 456, "2026-01-30", [
      { description: "Food", calories: 1000, emoji: "🍕" },
    ])
    repo.create(123, 456, "2026-01-31", [
      { description: "Food", calories: 1500, emoji: "🍕" },
    ])

    const totals = repo.getDailyTotals(123, "2026-01-25", "2026-01-31")
    expect(totals["2026-01-30"]).toBe(1000)
    expect(totals["2026-01-31"]).toBe(1500)
  })

  test("deletes a food item", () => {
    const log = repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ])
    repo.deleteItem(log.items[0].id!)
    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries[0].items.length).toBe(1)
  })

  test("updates a food item", () => {
    const log = repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
    ])
    repo.updateItem(log.items[0].id!, { calories: 200 })
    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries[0].items[0].calories).toBe(200)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db/repositories/food-logs.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/db/repositories/food-logs.ts
import { Database } from "bun:sqlite"

export interface FoodItem {
  id?: number
  description: string
  calories: number
  emoji?: string
}

export interface FoodLog {
  id: number
  telegram_id: number
  chat_id: number
  logged_at: string
  target_date: string
  items: FoodItem[]
}

export class FoodLogsRepository {
  constructor(private db: Database) {}

  create(
    telegramId: number,
    chatId: number,
    targetDate: string,
    items: FoodItem[]
  ): FoodLog {
    const logStmt = this.db.prepare(`
      INSERT INTO food_logs (telegram_id, chat_id, target_date)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    const logRow = logStmt.get(telegramId, chatId, targetDate) as {
      id: number
      telegram_id: number
      chat_id: number
      logged_at: string
      target_date: string
    }

    const itemStmt = this.db.prepare(`
      INSERT INTO food_items (log_id, description, calories, emoji)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        item.emoji ?? null
      ) as { id: number; description: string; calories: number; emoji: string | null }
      return { ...row, emoji: row.emoji ?? undefined }
    })

    return { ...logRow, items: insertedItems }
  }

  getByDate(telegramId: number, targetDate: string): FoodLog[] {
    const logsStmt = this.db.prepare(`
      SELECT * FROM food_logs
      WHERE telegram_id = ? AND target_date = ?
      ORDER BY logged_at
    `)
    const logs = logsStmt.all(telegramId, targetDate) as {
      id: number
      telegram_id: number
      chat_id: number
      logged_at: string
      target_date: string
    }[]

    const itemsStmt = this.db.prepare(
      "SELECT * FROM food_items WHERE log_id = ?"
    )

    return logs.map((log) => {
      const items = itemsStmt.all(log.id) as {
        id: number
        description: string
        calories: number
        emoji: string | null
      }[]
      return {
        ...log,
        items: items.map((i) => ({ ...i, emoji: i.emoji ?? undefined })),
      }
    })
  }

  getTotalCalories(telegramId: number, targetDate: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(fi.calories), 0) as total
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
    `)
    const result = stmt.get(telegramId, targetDate) as { total: number }
    return result.total
  }

  getDailyTotals(
    telegramId: number,
    startDate: string,
    endDate: string
  ): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT fl.target_date, COALESCE(SUM(fi.calories), 0) as total
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ?
        AND fl.target_date >= ?
        AND fl.target_date <= ?
      GROUP BY fl.target_date
    `)
    const rows = stmt.all(telegramId, startDate, endDate) as {
      target_date: string
      total: number
    }[]
    return Object.fromEntries(rows.map((r) => [r.target_date, r.total]))
  }

  deleteItem(itemId: number): void {
    const stmt = this.db.prepare("DELETE FROM food_items WHERE id = ?")
    stmt.run(itemId)
  }

  deleteAllForDate(telegramId: number, targetDate: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM food_logs
      WHERE telegram_id = ? AND target_date = ?
    `)
    const result = stmt.run(telegramId, targetDate)
    return result.changes
  }

  updateItem(
    itemId: number,
    updates: Partial<{ description: string; calories: number; emoji: string }>
  ): void {
    const sets: string[] = []
    const values: (string | number)[] = []

    if (updates.description !== undefined) {
      sets.push("description = ?")
      values.push(updates.description)
    }
    if (updates.calories !== undefined) {
      sets.push("calories = ?")
      values.push(updates.calories)
    }
    if (updates.emoji !== undefined) {
      sets.push("emoji = ?")
      values.push(updates.emoji)
    }

    if (sets.length === 0) return

    values.push(itemId)
    const sql = `UPDATE food_items SET ${sets.join(", ")} WHERE id = ?`
    this.db.run(sql, ...values)
  }

  getItemsByDate(telegramId: number, targetDate: string): (FoodItem & { log_id: number })[] {
    const stmt = this.db.prepare(`
      SELECT fi.*, fl.id as log_id
      FROM food_items fi
      JOIN food_logs fl ON fl.id = fi.log_id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
      ORDER BY fl.logged_at, fi.id
    `)
    return stmt.all(telegramId, targetDate) as (FoodItem & { log_id: number })[]
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db/repositories/food-logs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/food-logs.ts src/db/repositories/food-logs.test.ts
git commit -m "feat: add food-logs repository with items"
```

---

### Task 2.5: Conversation State Repository

**Files:**
- Create: `src/db/repositories/conversations.ts`
- Test: `src/db/repositories/conversations.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db/repositories/conversations.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { ConversationsRepository } from "./conversations"

describe("ConversationsRepository", () => {
  let db: Database
  let repo: ConversationsRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE conversation_state (
        telegram_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        pending_food TEXT,
        pending_items TEXT,
        context TEXT,
        target_date TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new ConversationsRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates conversation state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    const state = repo.get(123)
    expect(state?.state).toBe("awaiting_input")
  })

  test("updates existing state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    repo.upsert(123, 456, "clarifying", "2026-01-31", {
      pending_food: "chicken",
    })
    const state = repo.get(123)
    expect(state?.state).toBe("clarifying")
  })

  test("deletes conversation state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    repo.delete(123)
    expect(repo.get(123)).toBeNull()
  })

  test("checks if conversation exists", () => {
    expect(repo.exists(123)).toBe(false)
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    expect(repo.exists(123)).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db/repositories/conversations.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/db/repositories/conversations.ts
import { Database } from "bun:sqlite"

export type ConversationStateType = "awaiting_input" | "clarifying" | "confirming"

export interface ConversationState {
  telegram_id: number
  chat_id: number
  state: ConversationStateType
  pending_food: string | null
  pending_items: string | null
  context: string | null
  target_date: string
  updated_at: string
}

export class ConversationsRepository {
  constructor(private db: Database) {}

  upsert(
    telegramId: number,
    chatId: number,
    state: ConversationStateType,
    targetDate: string,
    data?: {
      pending_food?: string
      pending_items?: string
      context?: string
    }
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_state (telegram_id, chat_id, state, target_date, pending_food, pending_items, context, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(telegram_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        state = excluded.state,
        target_date = excluded.target_date,
        pending_food = excluded.pending_food,
        pending_items = excluded.pending_items,
        context = excluded.context,
        updated_at = datetime('now')
    `)
    stmt.run(
      telegramId,
      chatId,
      state,
      targetDate,
      data?.pending_food ?? null,
      data?.pending_items ?? null,
      data?.context ?? null
    )
  }

  get(telegramId: number): ConversationState | null {
    const stmt = this.db.prepare(
      "SELECT * FROM conversation_state WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) as ConversationState | null
  }

  delete(telegramId: number): void {
    const stmt = this.db.prepare(
      "DELETE FROM conversation_state WHERE telegram_id = ?"
    )
    stmt.run(telegramId)
  }

  exists(telegramId: number): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM conversation_state WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) !== null
  }

  deleteStale(timeoutMs: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM conversation_state
      WHERE datetime(updated_at) < datetime('now', ? || ' seconds')
    `)
    const result = stmt.run(-Math.floor(timeoutMs / 1000))
    return result.changes
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db/repositories/conversations.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/conversations.ts src/db/repositories/conversations.test.ts
git commit -m "feat: add conversations repository for /log state"
```

---

### Task 2.6: Pending Entries Repository

**Files:**
- Create: `src/db/repositories/pending.ts`
- Test: `src/db/repositories/pending.test.ts`

**Step 1: Write the failing test**

```typescript
// src/db/repositories/pending.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { PendingRepository } from "./pending"

describe("PendingRepository", () => {
  let db: Database
  let repo: PendingRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE pending_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        food_text TEXT NOT NULL,
        submitted_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TEXT
      )
    `)
    repo = new PendingRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates pending entry", () => {
    const entry = repo.create(123, 456, "chicken and rice", "2026-01-31")
    expect(entry.id).toBeDefined()
    expect(entry.food_text).toBe("chicken and rice")
  })

  test("gets pending entries for user", () => {
    repo.create(123, 456, "entry 1", "2026-01-31")
    repo.create(123, 456, "entry 2", "2026-01-31")

    const entries = repo.getByUser(123)
    expect(entries.length).toBe(2)
  })

  test("deletes entry", () => {
    const entry = repo.create(123, 456, "entry", "2026-01-31")
    repo.delete(entry.id)
    expect(repo.getByUser(123).length).toBe(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db/repositories/pending.test.ts`
Expected: FAIL - Cannot find module

**Step 3: Write implementation**

```typescript
// src/db/repositories/pending.ts
import { Database } from "bun:sqlite"

export interface PendingEntry {
  id: number
  telegram_id: number
  chat_id: number
  food_text: string
  submitted_at: string
  target_date: string
  retry_count: number
  last_retry_at: string | null
}

export class PendingRepository {
  constructor(private db: Database) {}

  create(
    telegramId: number,
    chatId: number,
    foodText: string,
    targetDate: string
  ): PendingEntry {
    const stmt = this.db.prepare(`
      INSERT INTO pending_entries (telegram_id, chat_id, food_text, target_date)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)
    return stmt.get(telegramId, chatId, foodText, targetDate) as PendingEntry
  }

  getByUser(telegramId: number): PendingEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_entries
      WHERE telegram_id = ?
      ORDER BY submitted_at
    `)
    return stmt.all(telegramId) as PendingEntry[]
  }

  getForRetry(limit: number): PendingEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_entries
      WHERE retry_count < 10
      ORDER BY submitted_at
      LIMIT ?
    `)
    return stmt.all(limit) as PendingEntry[]
  }

  incrementRetry(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE pending_entries
      SET retry_count = retry_count + 1, last_retry_at = datetime('now')
      WHERE id = ?
    `)
    stmt.run(id)
  }

  delete(id: number): void {
    const stmt = this.db.prepare("DELETE FROM pending_entries WHERE id = ?")
    stmt.run(id)
  }

  deleteAllForUser(telegramId: number): number {
    const stmt = this.db.prepare(
      "DELETE FROM pending_entries WHERE telegram_id = ?"
    )
    const result = stmt.run(telegramId)
    return result.changes
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db/repositories/pending.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/pending.ts src/db/repositories/pending.test.ts
git commit -m "feat: add pending entries repository"
```

---

## Phase 3: Bot Foundation

### Task 3.1: Bot Setup with Middleware

**Files:**
- Create: `src/bot/index.ts`
- Create: `src/bot/middleware/allowlist.ts`
- Update: `src/index.ts`

**Step 1: Create allowlist middleware**

```typescript
// src/bot/middleware/allowlist.ts
import { Context, NextFunction } from "grammy"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { config } from "../../config"

export function createAllowlistMiddleware(repo: AllowedUsersRepository) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (config.adminUsers.includes(userId)) {
      return next()
    }

    if (repo.isAllowed(userId)) {
      return next()
    }

    await ctx.reply("⛔ Sorry, this bot is invite-only.\nContact the admin to request access.")
  }
}
```

**Step 2: Create bot setup**

```typescript
// src/bot/index.ts
import { Bot, Context } from "grammy"
import { config } from "../config"
import { db } from "../db"
import { AllowedUsersRepository } from "../db/repositories/allowed-users"
import { UsersRepository } from "../db/repositories/users"
import { createAllowlistMiddleware } from "./middleware/allowlist"

export interface BotContext extends Context {}

export function createBot() {
  const bot = new Bot<BotContext>(config.telegram.botToken)

  const allowedUsersRepo = new AllowedUsersRepository(db)
  const usersRepo = new UsersRepository(db)

  bot.use(createAllowlistMiddleware(allowedUsersRepo))

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      usersRepo.upsert(ctx.from.id, ctx.from.username)
    }
    return next()
  })

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to TeleCal! 🍽️\n\n" +
        "Track your calories with AI-powered estimation.\n\n" +
        "Commands:\n" +
        "/log - Log what you ate\n" +
        "/today - See today's calories\n" +
        "/week - See past 7 days\n" +
        "/month - See past 30 days\n" +
        "/settings - Change preferences"
    )
  })

  return { bot, allowedUsersRepo, usersRepo }
}
```

**Step 3: Update entry point**

```typescript
// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"

console.log("TeleCal starting...")

initializeDatabase()
console.log("Database initialized")

const { bot } = createBot()

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} started`)
  },
})

process.on("SIGINT", () => {
  console.log("Shutting down...")
  bot.stop()
  process.exit(0)
})
```

**Step 4: Commit**

```bash
git add src/bot/index.ts src/bot/middleware/allowlist.ts src/index.ts
git commit -m "feat: add bot foundation with allowlist middleware"
```

---

### Task 3.2: Admin Commands

**Files:**
- Create: `src/bot/commands/admin.ts`
- Update: `src/bot/index.ts`

**Step 1: Create admin command**

```typescript
// src/bot/commands/admin.ts
import { Context } from "grammy"
import { config } from "../../config"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"

export function createAdminCommand(repo: AllowedUsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId || !config.adminUsers.includes(userId)) {
      await ctx.reply("⛔ Admin only command.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1)
    const subcommand = args[0]?.toLowerCase()

    if (!subcommand) {
      await ctx.reply(
        "Admin commands:\n" +
          "/admin add <user_id>\n" +
          "/admin remove <user_id>\n" +
          "/admin list"
      )
      return
    }

    switch (subcommand) {
      case "add": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await ctx.reply("Usage: /admin add <telegram_user_id>")
          return
        }
        repo.add(targetId, userId)
        await ctx.reply(`✓ Added user ${targetId} to allowlist`)
        break
      }

      case "remove": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await ctx.reply("Usage: /admin remove <telegram_user_id>")
          return
        }
        repo.remove(targetId)
        await ctx.reply(`✓ Removed user ${targetId} from allowlist`)
        break
      }

      case "list": {
        const users = repo.listAll()
        if (users.length === 0) {
          await ctx.reply("📋 Allowlist is empty")
          return
        }
        const lines = users.map((u) => `• ${u.telegram_id}`)
        await ctx.reply(`📋 Allowed users:\n${lines.join("\n")}`)
        break
      }

      default:
        await ctx.reply(`Unknown subcommand: ${subcommand}`)
    }
  }
}
```

**Step 2: Wire into bot**

Update `src/bot/index.ts` to add:
```typescript
import { createAdminCommand } from "./commands/admin"
// ... in createBot():
bot.command("admin", createAdminCommand(allowedUsersRepo))
```

**Step 3: Commit**

```bash
git add src/bot/commands/admin.ts src/bot/index.ts
git commit -m "feat: add /admin command for allowlist management"
```

---

## Phases 4-9: Remaining Implementation

The remaining phases follow the same TDD pattern:

**Phase 4: AI Service Layer**
- Task 4.1: AI types and interface
- Task 4.2: OpenAI provider
- Task 4.3: Anthropic provider
- Task 4.4: AI service with caching

**Phase 5: Core Commands**
- Task 5.1: Date parsing utility
- Task 5.2: /today command
- Task 5.3: /week and /month commands

**Phase 6: /log Conversation Flow**
- Task 6.1: Log flow state machine
- Task 6.2: Log command handler

**Phase 7: Edit, Delete, Settings, Pending**
- Task 7.1: /delete command
- Task 7.2: /edit command
- Task 7.3: /settings command with inline keyboards
- Task 7.4: /pending command

**Phase 8: Background Jobs**
- Task 8.1: Reminder job
- Task 8.2: Pending retry job

**Phase 9: Mini App**
- Task 9.1: Web server routes
- Task 9.2: Mini App frontend

---

## Execution Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1 | 1.1-1.2 | Project setup |
| 2 | 2.1-2.6 | Database layer |
| 3 | 3.1-3.2 | Bot foundation |
| 4 | 4.1-4.4 | AI service |
| 5 | 5.1-5.3 | Stats commands |
| 6 | 6.1-6.2 | /log conversation |
| 7 | 7.1-7.4 | CRUD commands |
| 8 | 8.1-8.2 | Background jobs |
| 9 | 9.1-9.2 | Mini App |

**Start execution:** Use `superpowers:executing-plans` skill in a new session.

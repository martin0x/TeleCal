# AI Usage & Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one row per billed AI call with tokens and USD cost, and surface it through `/admin usage` (dollars) and `/usage` (tokens only).

**Architecture:** `AIService` is the single accounting choke point. Providers report what they consumed via a new `ProviderResult` wrapper; `AIService` prices it with a code-constant pricing map and writes a row through `UsageRepository`. The estimation cache moves out of `AIService` into `CacheRepository`, so the service holds no `Database` and can be tested against fakes.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, grammy

**Spec:** `docs/superpowers/specs/2026-09-20-ai-usage-tracking-design.md` (see "Branch 3 — `feat/ai-usage-tracking`")

## Global Constraints

- Branch name: `feat/ai-usage-tracking`, cut from `refactor/openai-responses-api` **after it merges**.
- Model ids in `MODEL_PRICING` must exactly match the ids in the provider files: `gpt-5.6-luna`, `claude-haiku-4-5-20251001`, `gemini-3.1-flash-lite`. A mismatch silently produces `cost_usd = 0`.
- Prices are USD per 1M tokens, verified 2026-09-20. Use these exact values:
  - `gpt-5.6-luna` — input `0.20`, cachedInput `0.02`, output `1.20`
  - `claude-haiku-4-5-20251001` — input `1.00`, cachedInput `0.10`, output `5.00`
  - `gemini-3.1-flash-lite` — input `0.25`, cachedInput `0.25`, output `1.50`
- **`reasoning_tokens` is a subset of `output_tokens`.** Never add it to the cost calculation; it is already billed as output. It is stored for diagnostics only.
- **Cache writes are recorded but priced at the base input rate.** No `cacheWrite` field goes in the pricing map. If Anthropic prompt caching is ever enabled, this must be revisited.
- **Every row counts toward cost and token totals regardless of `status`.** `status` is diagnostic and must never appear in a bot message.
- **Cache hits write no row.** Nothing was billed.
- **`/usage` shows no dollar figures.** Cost is admin-only.
- **Usage recording must never fail a food log.** Every `record()` call is wrapped in try/catch that logs and swallows.
- New test files use `createTestDb()` from Task 1. **Do not retrofit the eight existing test files** — that is unrelated churn.

---

### Task 1: Add the `ai_usage` table and a schema-reading test helper

Every repository test in this repo hand-copies its own `CREATE TABLE` into `beforeEach`, and they have already drifted — `food-logs.test.ts:14-21` omits the foreign key that `schema.sql:29` declares. Adding two more hand-copies would extend the problem, so new tests read the real schema.

**Files:**
- Modify: `src/db/schema.sql` (append)
- Create: `src/db/test-helpers.ts`
- Test: `src/db/test-helpers.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `createTestDb(): Database` — an in-memory SQLite database with the full production schema applied

- [ ] **Step 1: Create the branch**

```bash
git checkout refactor/openai-responses-api
git pull
git checkout -b feat/ai-usage-tracking
```

If that branch has merged, branch from `main`.

- [ ] **Step 2: Write the failing test**

Create `src/db/test-helpers.test.ts`:

```typescript
// src/db/test-helpers.test.ts
import { describe, test, expect } from "bun:test"
import { createTestDb } from "./test-helpers"

describe("createTestDb", () => {
  test("applies the production schema", () => {
    const db = createTestDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)

    expect(names).toContain("users")
    expect(names).toContain("food_logs")
    expect(names).toContain("estimation_cache")
    expect(names).toContain("ai_usage")
  })

  test("ai_usage has every column the usage repository writes", () => {
    const db = createTestDb()
    const columns = db.prepare("PRAGMA table_info(ai_usage)").all() as { name: string }[]
    const names = columns.map((c) => c.name)

    expect(names).toEqual([
      "id",
      "telegram_id",
      "chat_id",
      "provider",
      "model",
      "input_tokens",
      "cached_input_tokens",
      "cache_write_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cost_usd",
      "call_type",
      "status",
      "created_at",
    ])
  })

  test("each call returns an isolated database", () => {
    const a = createTestDb()
    const b = createTestDb()
    a.run("INSERT INTO users (telegram_id) VALUES (1)")

    expect(b.prepare("SELECT COUNT(*) as n FROM users").get()).toEqual({ n: 0 })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
bun test src/db/test-helpers.test.ts
```

Expected: FAIL — `Cannot find module './test-helpers'`.

- [ ] **Step 4: Append the table to the schema**

Add to the end of `src/db/schema.sql`:

```sql
-- Per-call AI usage and cost accounting
-- No FK to users: usage history must outlive the user record it describes.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  -- Subset of input_tokens billed at the cached rate. Null when unreported.
  cached_input_tokens INTEGER,
  -- Subset of input_tokens written to cache. Recorded, not separately priced.
  cache_write_tokens INTEGER,
  output_tokens INTEGER NOT NULL,
  -- Subset of output_tokens, NEVER added to it. Billed as output. OpenAI only.
  reasoning_tokens INTEGER,
  cost_usd REAL NOT NULL,
  call_type TEXT NOT NULL,      -- estimate | clarify | edit | retry
  status TEXT NOT NULL,         -- ok | parse_error | no_usage
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date
  ON ai_usage(telegram_id, created_at);
```

Column order must match the test in Step 2 exactly.

- [ ] **Step 5: Write the helper**

Create `src/db/test-helpers.ts`:

```typescript
// src/db/test-helpers.ts
// Test-only: builds an in-memory database from the real schema, so tests
// cannot drift from production DDL the way hand-copied CREATE TABLE
// statements in the older test files have.
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"

export function createTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf-8")
  db.run(schema)
  return db
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test src/db/test-helpers.test.ts
```

Expected: 3 PASS.

- [ ] **Step 7: Confirm the real app still boots its schema**

```bash
bun test
```

Expected: the existing suite still passes. The eight older test files use their own inline DDL and are unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/test-helpers.ts src/db/test-helpers.test.ts
git commit -m "feat(db): add ai_usage table and schema-reading test helper"
```

---

### Task 2: Add usage types and the pricing module

**Files:**
- Modify: `src/ai/types.ts` (append)
- Create: `src/ai/pricing.ts`
- Test: `src/ai/pricing.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `TokenUsage { model, inputTokens, cachedInputTokens?, cacheWriteTokens?, outputTokens, reasoningTokens? }`
  - `ProviderResult { estimate: EstimationResult, usage: TokenUsage }`
  - `CallType = "estimate" | "clarify" | "edit" | "retry"`
  - `UsageStatus = "ok" | "parse_error" | "no_usage"`
  - `MODEL_PRICING: Record<string, ModelPrice>`
  - `calculateCost(usage: TokenUsage): number`

- [ ] **Step 1: Add the types**

Append to `src/ai/types.ts`:

```typescript
export interface TokenUsage {
  /** Model id as reported by the API, falling back to the requested constant. */
  model: string
  inputTokens: number
  /** Subset of inputTokens billed at the cached rate. */
  cachedInputTokens?: number
  /** Subset of inputTokens written to cache. Recorded, not separately priced. */
  cacheWriteTokens?: number
  outputTokens: number
  /** Subset of outputTokens. Already billed as output — never add it again. */
  reasoningTokens?: number
}

export interface ProviderResult {
  estimate: EstimationResult
  usage: TokenUsage
}

export type CallType = "estimate" | "clarify" | "edit" | "retry"

export type UsageStatus = "ok" | "parse_error" | "no_usage"
```

Do **not** change `AIProvider` yet — Task 5 does that, once the providers are ready to satisfy it.

- [ ] **Step 2: Write the failing test**

Create `src/ai/pricing.test.ts`:

```typescript
// src/ai/pricing.test.ts
import { describe, test, expect } from "bun:test"
import { calculateCost, MODEL_PRICING } from "./pricing"
import type { TokenUsage } from "./types"

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { model: "gpt-5.6-luna", inputTokens: 0, outputTokens: 0, ...over }
}

describe("MODEL_PRICING", () => {
  test("covers every model the providers request", () => {
    expect(MODEL_PRICING["gpt-5.6-luna"]).toBeDefined()
    expect(MODEL_PRICING["claude-haiku-4-5-20251001"]).toBeDefined()
    expect(MODEL_PRICING["gemini-3.1-flash-lite"]).toBeDefined()
  })
})

describe("calculateCost", () => {
  test("prices exactly one million input tokens at the input rate", () => {
    expect(calculateCost(usage({ inputTokens: 1_000_000 }))).toBeCloseTo(0.2, 10)
  })

  test("prices exactly one million output tokens at the output rate", () => {
    expect(calculateCost(usage({ outputTokens: 1_000_000 }))).toBeCloseTo(1.2, 10)
  })

  test("bills cached input at the cached rate and the rest at full rate", () => {
    // 600 uncached * 0.20 + 400 cached * 0.02 + 100 output * 1.20 = 248 / 1e6
    const cost = calculateCost(
      usage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 })
    )
    expect(cost).toBeCloseTo(248 / 1_000_000, 12)
  })

  test("does not add reasoning tokens on top of output tokens", () => {
    const withReasoning = calculateCost(usage({ outputTokens: 1000, reasoningTokens: 800 }))
    const without = calculateCost(usage({ outputTokens: 1000 }))
    expect(withReasoning).toBe(without)
  })

  test("does not surcharge cache writes", () => {
    const withWrites = calculateCost(usage({ inputTokens: 1000, cacheWriteTokens: 900 }))
    const without = calculateCost(usage({ inputTokens: 1000 }))
    expect(withWrites).toBe(without)
  })

  test("returns zero for an unknown model", () => {
    const cost = calculateCost(
      usage({ model: "some-model-we-never-heard-of", inputTokens: 5000, outputTokens: 5000 })
    )
    expect(cost).toBe(0)
  })

  test("returns zero for zero tokens", () => {
    expect(calculateCost(usage())).toBe(0)
  })

  test("never returns negative cost when cached exceeds input", () => {
    // Defensive: a provider reporting cached > input must not produce a credit.
    expect(calculateCost(usage({ inputTokens: 100, cachedInputTokens: 500 }))).toBeGreaterThanOrEqual(0)
  })

  test("prices each configured model with its own rates", () => {
    const haiku = calculateCost({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(haiku).toBeCloseTo(1.0, 10)

    const gemini = calculateCost({
      model: "gemini-3.1-flash-lite",
      inputTokens: 0,
      outputTokens: 1_000_000,
    })
    expect(gemini).toBeCloseTo(1.5, 10)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
bun test src/ai/pricing.test.ts
```

Expected: FAIL — `Cannot find module './pricing'`.

- [ ] **Step 4: Write the pricing module**

Create `src/ai/pricing.ts`:

```typescript
// src/ai/pricing.ts
import type { TokenUsage } from "./types"

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M input tokens served from cache. */
  cachedInput: number
  /** USD per 1M output tokens (reasoning tokens included). */
  output: number
}

/**
 * Prices in USD per 1M tokens. Verified 2026-09-20 against:
 *   https://developers.openai.com/api/docs/pricing
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://ai.google.dev/gemini-api/docs/pricing
 *
 * Keys must exactly match the model ids the providers request. A mismatch
 * degrades to cost 0 with a warning rather than dropping the row.
 *
 * Known simplifications (see the design doc):
 * - Cache WRITES are priced at the base input rate. gpt-5.6-luna publishes no
 *   write premium, and Anthropic's 1.25x premium applies only with explicit
 *   cache_control, which TeleCal does not use. Revisit if that changes.
 * - Gemini has no distinct cached rate here; cachedInput equals input.
 * - Batch, fast-mode, and audio rates are not modelled.
 *
 * claude-haiku-4-5-20251001 retirement is published as "not sooner than
 * 2026-10-15" — see https://github.com/martin0x/TeleCal/issues/1
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "claude-haiku-4-5-20251001": { input: 1.0, cachedInput: 0.1, output: 5.0 },
  "gemini-3.1-flash-lite": { input: 0.25, cachedInput: 0.25, output: 1.5 },
}

const warnedModels = new Set<string>()

/**
 * Cost in USD for one call. Unknown models return 0 so that token counts are
 * still recorded — "tokens tracked, cost unknown" beats losing the row.
 */
export function calculateCost(usage: TokenUsage): number {
  const price = MODEL_PRICING[usage.model]
  if (!price) {
    if (!warnedModels.has(usage.model)) {
      warnedModels.add(usage.model)
      console.warn(
        `[pricing] No price for model "${usage.model}". Recording tokens with cost 0. ` +
          `Add it to MODEL_PRICING in src/ai/pricing.ts.`
      )
    }
    return 0
  }

  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const uncached = usage.inputTokens - cached

  return (
    (uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test src/ai/pricing.test.ts
```

Expected: 10 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/types.ts src/ai/pricing.ts src/ai/pricing.test.ts
git commit -m "feat(ai): add token usage types and model pricing"
```

---

### Task 3: Build `UsageRepository`

**Files:**
- Create: `src/db/repositories/usage.ts`
- Test: `src/db/repositories/usage.test.ts`

**Interfaces:**
- Consumes: `createTestDb()` (Task 1); `CallType`, `UsageStatus` (Task 2)
- Produces:
  - `UsageEntry` — the shape `record()` accepts
  - `UsageTotals { calls, inputTokens, outputTokens, costUsd }`
  - `UserUsageRow extends UsageTotals { telegramId, username }`
  - `ModelUsageRow extends UsageTotals { model }`
  - `new UsageRepository(db)` with `record`, `getUserTotals`, `getAllUserTotals`, `getModelBreakdown`

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/usage.test.ts`:

```typescript
// src/db/repositories/usage.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { UsageRepository, type UsageEntry } from "./usage"

let db: Database
let repo: UsageRepository

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    telegramId: 1,
    chatId: 100,
    provider: "openai",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 0,
    costUsd: 0.00008,
    callType: "estimate",
    status: "ok",
    ...over,
  }
}

beforeEach(() => {
  db = createTestDb()
  repo = new UsageRepository(db)
})

describe("record", () => {
  test("round-trips every column", () => {
    repo.record(
      entry({
        telegramId: 42,
        chatId: -1001,
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
        inputTokens: 300,
        cachedInputTokens: 120,
        cacheWriteTokens: 30,
        outputTokens: 80,
        reasoningTokens: 12,
        costUsd: 0.000165,
        callType: "clarify",
        status: "parse_error",
      })
    )

    const row = db.prepare("SELECT * FROM ai_usage").get() as any
    expect(row.telegram_id).toBe(42)
    expect(row.chat_id).toBe(-1001)
    expect(row.provider).toBe("gemini")
    expect(row.model).toBe("gemini-3.1-flash-lite")
    expect(row.input_tokens).toBe(300)
    expect(row.cached_input_tokens).toBe(120)
    expect(row.cache_write_tokens).toBe(30)
    expect(row.output_tokens).toBe(80)
    expect(row.reasoning_tokens).toBe(12)
    expect(row.cost_usd).toBeCloseTo(0.000165, 10)
    expect(row.call_type).toBe("clarify")
    expect(row.status).toBe("parse_error")
    expect(row.created_at).toBeTruthy()
  })

  test("accepts null chat_id and null optional token counts", () => {
    repo.record(
      entry({ chatId: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null })
    )

    const row = db.prepare("SELECT * FROM ai_usage").get() as any
    expect(row.chat_id).toBeNull()
    expect(row.cached_input_tokens).toBeNull()
    expect(row.reasoning_tokens).toBeNull()
  })
})

describe("getUserTotals", () => {
  test("sums only the requested user", () => {
    repo.record(entry({ telegramId: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.01 }))
    repo.record(entry({ telegramId: 1, inputTokens: 200, outputTokens: 20, costUsd: 0.02 }))
    repo.record(entry({ telegramId: 2, inputTokens: 900, outputTokens: 90, costUsd: 0.09 }))

    const totals = repo.getUserTotals(1, 30)
    expect(totals.calls).toBe(2)
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(30)
    expect(totals.costUsd).toBeCloseTo(0.03, 10)
  })

  test("includes non-ok rows, because those tokens were still billed", () => {
    repo.record(entry({ telegramId: 1, costUsd: 0.01, status: "ok" }))
    repo.record(entry({ telegramId: 1, costUsd: 0.02, status: "parse_error" }))
    repo.record(entry({ telegramId: 1, costUsd: 0.03, status: "no_usage" }))

    const totals = repo.getUserTotals(1, 30)
    expect(totals.calls).toBe(3)
    expect(totals.costUsd).toBeCloseTo(0.06, 10)
  })

  test("returns zeroes rather than nulls for a user with no rows", () => {
    const totals = repo.getUserTotals(999, 30)
    expect(totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })

  test("excludes rows older than the window", () => {
    repo.record(entry({ telegramId: 1, costUsd: 0.01 }))
    db.run("UPDATE ai_usage SET created_at = datetime('now', '-40 days')")
    repo.record(entry({ telegramId: 1, costUsd: 0.02 }))

    expect(repo.getUserTotals(1, 30).calls).toBe(1)
  })

  test("sinceDays of 0 means all time", () => {
    repo.record(entry({ telegramId: 1 }))
    db.run("UPDATE ai_usage SET created_at = datetime('now', '-400 days')")
    repo.record(entry({ telegramId: 1 }))

    expect(repo.getUserTotals(1, 0).calls).toBe(2)
  })
})

describe("getAllUserTotals", () => {
  test("groups by user, ordered by cost descending", () => {
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'ray')")
    repo.record(entry({ telegramId: 1, costUsd: 0.01 }))
    repo.record(entry({ telegramId: 2, costUsd: 0.05 }))

    const rows = repo.getAllUserTotals(30)
    expect(rows).toHaveLength(2)
    expect(rows[0].telegramId).toBe(2)
    expect(rows[0].costUsd).toBeCloseTo(0.05, 10)
    expect(rows[1].telegramId).toBe(1)
    expect(rows[1].username).toBe("ray")
  })

  test("includes users with usage but no users row", () => {
    // Admins bypass the allowlist and may never be inserted into users.
    repo.record(entry({ telegramId: 777, costUsd: 0.01 }))

    const rows = repo.getAllUserTotals(30)
    expect(rows).toHaveLength(1)
    expect(rows[0].telegramId).toBe(777)
    expect(rows[0].username).toBeNull()
  })
})

describe("getModelBreakdown", () => {
  test("groups by model, ordered by cost descending", () => {
    repo.record(entry({ model: "gpt-5.6-luna", costUsd: 0.01 }))
    repo.record(entry({ model: "gpt-5.6-luna", costUsd: 0.02 }))
    repo.record(entry({ model: "gemini-3.1-flash-lite", costUsd: 0.10 }))

    const rows = repo.getModelBreakdown(30)
    expect(rows).toHaveLength(2)
    expect(rows[0].model).toBe("gemini-3.1-flash-lite")
    expect(rows[1].model).toBe("gpt-5.6-luna")
    expect(rows[1].calls).toBe(2)
    expect(rows[1].costUsd).toBeCloseTo(0.03, 10)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test src/db/repositories/usage.test.ts
```

Expected: FAIL — `Cannot find module './usage'`.

- [ ] **Step 3: Write the repository**

Create `src/db/repositories/usage.ts`:

```typescript
// src/db/repositories/usage.ts
import { Database } from "bun:sqlite"
import type { CallType, UsageStatus } from "../../ai/types"

export interface UsageEntry {
  telegramId: number
  chatId: number | null
  provider: string
  model: string
  inputTokens: number
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number
  reasoningTokens: number | null
  costUsd: number
  callType: CallType
  status: UsageStatus
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UserUsageRow extends UsageTotals {
  telegramId: number
  username: string | null
}

export interface ModelUsageRow extends UsageTotals {
  model: string
}

const TOTALS_COLUMNS = `
  COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd
`

/**
 * Builds the time-window predicate. sinceDays of 0 (or less) means all time.
 * The value is coerced to a non-negative integer before interpolation, since
 * SQLite cannot parameterise the modifier string of datetime().
 */
function windowClause(sinceDays: number, prefix: "WHERE" | "AND"): string {
  const days = Math.max(0, Math.floor(sinceDays))
  if (days === 0) return ""
  return ` ${prefix} created_at >= datetime('now', '-${days} days')`
}

export class UsageRepository {
  constructor(private db: Database) {}

  record(entry: UsageEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO ai_usage (
        telegram_id, chat_id, provider, model,
        input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens,
        cost_usd, call_type, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      entry.telegramId,
      entry.chatId,
      entry.provider,
      entry.model,
      entry.inputTokens,
      entry.cachedInputTokens,
      entry.cacheWriteTokens,
      entry.outputTokens,
      entry.reasoningTokens,
      entry.costUsd,
      entry.callType,
      entry.status
    )
  }

  getUserTotals(telegramId: number, sinceDays: number): UsageTotals {
    const stmt = this.db.prepare(`
      SELECT ${TOTALS_COLUMNS}
      FROM ai_usage
      WHERE telegram_id = ?${windowClause(sinceDays, "AND")}
    `)
    return stmt.get(telegramId) as UsageTotals
  }

  getAllUserTotals(sinceDays: number): UserUsageRow[] {
    // Both ai_usage and users have telegram_id and created_at columns, so the
    // window predicate must be qualified with the ai_usage alias.
    const window = windowClause(sinceDays, "WHERE").replace("created_at", "u.created_at")
    const stmt = this.db.prepare(`
      SELECT
        u.telegram_id AS telegramId,
        users.username AS username,
        ${TOTALS_COLUMNS}
      FROM ai_usage u
      LEFT JOIN users ON users.telegram_id = u.telegram_id
      ${window}
      GROUP BY u.telegram_id, users.username
      ORDER BY costUsd DESC
    `)
    return stmt.all() as UserUsageRow[]
  }

  getModelBreakdown(sinceDays: number): ModelUsageRow[] {
    const stmt = this.db.prepare(`
      SELECT model, ${TOTALS_COLUMNS}
      FROM ai_usage
      ${windowClause(sinceDays, "WHERE")}
      GROUP BY model
      ORDER BY costUsd DESC
    `)
    return stmt.all() as ModelUsageRow[]
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/db/repositories/usage.test.ts
```

Expected: all PASS.

`getAllUserTotals` is the one query here with real complexity: `ai_usage` and `users` both have `telegram_id` and `created_at` columns, so an unqualified reference to either is an SQLite "ambiguous column name" error. If you see that error, the qualification is what needs fixing, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/usage.ts src/db/repositories/usage.test.ts
git commit -m "feat(db): add UsageRepository with per-user and per-model aggregates"
```

---

### Task 4: Extract `CacheRepository` and rewire `AIService`'s constructor

`AIService` currently hand-rolls SQL for the estimation cache — the only raw SQL outside `src/db/repositories/` in this codebase. Moving it out lets the service hold no `Database` at all, which makes Task 6's accounting testable without SQLite.

No behavior changes in this task. Usage recording arrives in Task 6.

**Files:**
- Create: `src/db/repositories/cache.ts`
- Test: `src/db/repositories/cache.test.ts`
- Modify: `src/ai/service.ts` (constructor, `getFromCache`, `saveToCache`)
- Modify: `src/bot/index.ts:33`
- Modify: `scripts/smoke-providers.ts` (constructor call)

**Interfaces:**
- Consumes: `createTestDb()` (Task 1); `UsageRepository` (Task 3)
- Produces:
  - `new CacheRepository(db)` with `get(normalizedFood): EstimationResult | null` and `set(normalizedFood, result): void`
  - `new AIService(cacheRepo: CacheRepository, usageRepo: UsageRepository)`

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/cache.test.ts`:

```typescript
// src/db/repositories/cache.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { CacheRepository } from "./cache"
import type { EstimationResult } from "../../ai/types"

let db: Database
let repo: CacheRepository

const RESULT: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
  needsClarification: false,
  confidence: "high",
}

beforeEach(() => {
  db = createTestDb()
  repo = new CacheRepository(db)
})

test("returns null for a miss", () => {
  expect(repo.get("chicken adobo")).toBeNull()
})

test("round-trips a stored estimate", () => {
  repo.set("chicken adobo", RESULT)
  expect(repo.get("chicken adobo")).toEqual(RESULT)
})

test("overwrites an existing entry for the same key", () => {
  repo.set("chicken adobo", RESULT)
  repo.set("chicken adobo", { ...RESULT, items: [{ description: "Adobo", calories: 500 }] })

  expect(repo.get("chicken adobo")!.items[0].calories).toBe(500)
  expect(db.prepare("SELECT COUNT(*) as n FROM estimation_cache").get()).toEqual({ n: 1 })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test src/db/repositories/cache.test.ts
```

Expected: FAIL — `Cannot find module './cache'`.

- [ ] **Step 3: Create the repository by moving the existing SQL**

Create `src/db/repositories/cache.ts`. This is the SQL from `src/ai/service.ts` moved verbatim, not rewritten:

```typescript
// src/db/repositories/cache.ts
import { Database } from "bun:sqlite"
import type { EstimationResult, CachedEstimation } from "../../ai/types"

export class CacheRepository {
  constructor(private db: Database) {}

  get(normalizedFood: string): EstimationResult | null {
    const stmt = this.db.prepare(
      "SELECT result_json FROM estimation_cache WHERE normalized_food = ?"
    )
    const row = stmt.get(normalizedFood) as CachedEstimation | null
    return row ? (JSON.parse(row.result_json) as EstimationResult) : null
  }

  set(normalizedFood: string, result: EstimationResult): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO estimation_cache (normalized_food, result_json, created_at)
      VALUES (?, ?, datetime('now'))
    `)
    stmt.run(normalizedFood, JSON.stringify(result))
  }
}
```

- [ ] **Step 4: Run the cache tests to verify they pass**

```bash
bun test src/db/repositories/cache.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Rewire `AIService`**

In `src/ai/service.ts`: delete the `db` field, the `Database` import, and the private `getFromCache`/`saveToCache` methods. Change the constructor and the two cache call sites:

```typescript
import { AIProvider, EstimationResult } from "./types"
import { OpenAIProvider } from "./providers/openai"
import { AnthropicProvider } from "./providers/anthropic"
import { GeminiProvider } from "./providers/gemini"
import { CacheRepository } from "../db/repositories/cache"
import { UsageRepository } from "../db/repositories/usage"
import { config } from "../config"

export class AIService {
  private providers: Map<string, AIProvider> = new Map()

  constructor(
    private cache: CacheRepository,
    private usage: UsageRepository
  ) {
    if (config.ai.openaiApiKey) {
      this.providers.set("openai", new OpenAIProvider())
    }
    if (config.ai.anthropicApiKey) {
      this.providers.set("anthropic", new AnthropicProvider())
    }
    if (config.ai.googleApiKey) {
      this.providers.set("gemini", new GeminiProvider())
    }
  }
```

Replace `this.getFromCache(normalizedFood)` with `this.cache.get(normalizedFood)` and `this.saveToCache(normalizedFood, result)` with `this.cache.set(normalizedFood, result)`.

The `usage` field is unused until Task 6. That is expected.

- [ ] **Step 6: Update the two construction sites**

`src/bot/index.ts:33`:

```typescript
  const aiService = new AIService(new CacheRepository(db), new UsageRepository(db))
```

Add the two imports at the top of that file.

`scripts/smoke-providers.ts` — replace `new AIService(db)`, and swap its inline `CREATE TABLE` for the shared helper now that one exists:

```typescript
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"

const db = createTestDb()
const service = new AIService(new CacheRepository(db), new UsageRepository(db))
```

- [ ] **Step 7: Typecheck and run the whole suite**

```bash
bunx tsc --noEmit
bun test
```

Expected: no type errors; all tests pass. `log-flow.test.ts` constructs a fake `AIService` object and casts it, so the constructor change does not affect it.

- [ ] **Step 8: Verify caching still works end to end**

```bash
bun run scripts/smoke-providers.ts gemini
```

Expected: `✓ gemini responded`.

- [ ] **Step 9: Commit**

```bash
git add src/db/repositories/cache.ts src/db/repositories/cache.test.ts src/ai/service.ts src/bot/index.ts scripts/smoke-providers.ts
git commit -m "refactor(ai): extract CacheRepository so AIService holds no Database"
```

---

### Task 5: Return token usage from all three providers

**Files:**
- Modify: `src/ai/types.ts` (the `AIProvider` interface)
- Modify: `src/ai/providers/openai.ts`, `anthropic.ts`, `gemini.ts`
- Modify: `src/ai/service.ts` (unwrap `ProviderResult`)
- Test: `src/ai/providers/openai.test.ts` (extend), `anthropic.test.ts` (create), `gemini.test.ts` (create)

**Interfaces:**
- Consumes: `TokenUsage`, `ProviderResult` (Task 2)
- Produces: `AIProvider.estimate(food, context?): Promise<ProviderResult>`

- [ ] **Step 1: Write the failing tests**

Extend `src/ai/providers/openai.test.ts` with:

```typescript
describe("OpenAIProvider usage reporting", () => {
  test("reports tokens from the Responses usage block", async () => {
    const { client } = fakeClient(VALID_REPLY)
    const result = await new OpenAIProvider(client).estimate("two eggs")

    expect(result.usage).toEqual({
      model: "gpt-5.6-luna",
      inputTokens: 120,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 45,
      reasoningTokens: 0,
    })
    expect(result.estimate.items).toHaveLength(1)
  })
})
```

Note this changes the existing tests in that file: `provider.estimate(...)` now returns `{ estimate, usage }`, so assertions like `result.items` become `result.estimate.items`. Update them.

Create `src/ai/providers/anthropic.test.ts`:

```typescript
// src/ai/providers/anthropic.test.ts
import { describe, test, expect } from "bun:test"
import Anthropic from "@anthropic-ai/sdk"
import { AnthropicProvider } from "./anthropic"

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  confidence: "high",
})

function fakeClient(text: string, usage?: Record<string, number>) {
  return {
    messages: {
      create: async () => ({
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text }],
        usage: usage ?? { input_tokens: 200, output_tokens: 60 },
      }),
    },
  } as unknown as Anthropic
}

describe("AnthropicProvider", () => {
  test("reports tokens from the usage block", async () => {
    const result = await new AnthropicProvider(fakeClient(VALID_REPLY)).estimate("two eggs")

    expect(result.usage.model).toBe("claude-haiku-4-5-20251001")
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(60)
    expect(result.estimate.items).toHaveLength(1)
  })

  test("reports cache read tokens when present", async () => {
    const client = fakeClient(VALID_REPLY, {
      input_tokens: 200,
      output_tokens: 60,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 20,
    })
    const result = await new AnthropicProvider(client).estimate("two eggs")

    expect(result.usage.cachedInputTokens).toBe(150)
    expect(result.usage.cacheWriteTokens).toBe(20)
  })

  test("still strips markdown fences", async () => {
    const fenced = "```json\n" + VALID_REPLY + "\n```"
    const result = await new AnthropicProvider(fakeClient(fenced)).estimate("two eggs")

    expect(result.estimate.items[0].calories).toBe(180)
  })
})
```

Create `src/ai/providers/gemini.test.ts`:

```typescript
// src/ai/providers/gemini.test.ts
import { describe, test, expect } from "bun:test"
import { GeminiProvider } from "./gemini"

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  confidence: "high",
})

function fakeClient(text: string, usageMetadata?: Record<string, number>) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: {
          text: () => text,
          usageMetadata: usageMetadata ?? {
            promptTokenCount: 310,
            candidatesTokenCount: 70,
            totalTokenCount: 380,
          },
        },
      }),
    }),
  } as any
}

describe("GeminiProvider", () => {
  test("reports tokens from usageMetadata, nested under response", async () => {
    const result = await new GeminiProvider(fakeClient(VALID_REPLY)).estimate("two eggs")

    expect(result.usage.model).toBe("gemini-3.1-flash-lite")
    expect(result.usage.inputTokens).toBe(310)
    expect(result.usage.outputTokens).toBe(70)
    expect(result.estimate.items).toHaveLength(1)
  })

  test("reports zero tokens when usageMetadata is absent", async () => {
    const client = {
      getGenerativeModel: () => ({
        generateContent: async () => ({ response: { text: () => VALID_REPLY } }),
      }),
    } as any
    const result = await new GeminiProvider(client).estimate("two eggs")

    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
bun test src/ai/providers/
```

Expected: FAIL — the providers return `EstimationResult`, so `result.usage` is undefined, and Anthropic/Gemini do not yet accept an injected client.

- [ ] **Step 3: Change the interface**

In `src/ai/types.ts`:

```typescript
export interface AIProvider {
  name: string
  estimate(foodDescription: string, context?: string): Promise<ProviderResult>
}
```

- [ ] **Step 4: Update the OpenAI provider**

In `src/ai/providers/openai.ts`, change the return type and wrap the result:

```typescript
  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    // ... existing request unchanged ...

    const result = JSON.parse(content) as { /* unchanged */ }

    return {
      estimate: {
        items: result.items || [],
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion || undefined,
        confidence: result.confidence || "medium",
      },
      usage: {
        model: response.model ?? "gpt-5.6-luna",
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
    }
  }
```

- [ ] **Step 5: Update the Anthropic provider**

Make the client injectable and wrap the result. In `src/ai/providers/anthropic.ts`:

```typescript
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: config.ai.anthropicApiKey })
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    // ... existing request and fence-stripping unchanged ...

    const result = JSON.parse(jsonStr) as { /* unchanged */ }
    const usage = response.usage as {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }

    return {
      estimate: {
        items: result.items || [],
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion,
        confidence: result.confidence || "medium",
      },
      usage: {
        model: response.model ?? "claude-haiku-4-5-20251001",
        inputTokens: usage?.input_tokens ?? 0,
        cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
    }
  }
```

Keep the fence-stripping. Anthropic has no strict structured-output mode here.

- [ ] **Step 6: Update the Gemini provider**

Make the client injectable and wrap the result. In `src/ai/providers/gemini.ts`:

```typescript
  constructor(client?: GoogleGenerativeAI) {
    this.client = client ?? new GoogleGenerativeAI(config.ai.googleApiKey)
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    // ... existing request and fence-stripping unchanged ...

    // usageMetadata is nested under result.response, not on the result itself.
    const meta = response.usageMetadata

    return {
      estimate: {
        items: parsed.items || [],
        needsClarification: parsed.needsClarification || false,
        clarificationQuestion: parsed.clarificationQuestion,
        confidence: parsed.confidence || "medium",
      },
      usage: {
        model: "gemini-3.1-flash-lite",
        inputTokens: meta?.promptTokenCount ?? 0,
        cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
        outputTokens: meta?.candidatesTokenCount ?? 0,
      },
    }
  }
```

Gemini does not echo the model id in the response, so the requested constant is used. Keep it identical to the string in `getGenerativeModel`.

- [ ] **Step 7: Unwrap in `AIService`**

In `estimateWithProvider`, the provider now returns a wrapper. Cache only the estimate:

```typescript
  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    context?: string
  ): Promise<EstimationResult> {
    const { estimate } = await provider.estimate(foodDescription, context)

    if (!estimate.needsClarification && !context && config.features.caching) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }
```

Recording arrives in Task 6.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
bun test src/ai/
bunx tsc --noEmit
```

Expected: all provider tests PASS, no type errors.

- [ ] **Step 9: Smoke-test all three live**

```bash
bun run scripts/smoke-providers.ts openai
bun run scripts/smoke-providers.ts anthropic
bun run scripts/smoke-providers.ts gemini
```

Expected: three `✓`. **Paste the live `usage` values into your report** — these confirm the field paths against real responses, which no fake can prove.

- [ ] **Step 10: Commit**

```bash
git add src/ai/
git commit -m "feat(ai): report token usage from all three providers"
```

---

### Task 6: Record usage in `AIService`

**Files:**
- Modify: `src/ai/service.ts`
- Test: `src/ai/service.test.ts` (create)

**Interfaces:**
- Consumes: `CacheRepository` (Task 4), `UsageRepository` (Task 3), `calculateCost` (Task 2), `ProviderResult` (Task 5)
- Produces: `estimate(food, provider, opts: { telegramId, chatId, callType, context? }): Promise<EstimationResult>`

- [ ] **Step 1: Write the failing test**

Create `src/ai/service.test.ts`:

```typescript
// src/ai/service.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { AIService } from "./service"
import type { AIProvider, ProviderResult, EstimationResult } from "./types"
import type { CacheRepository } from "../db/repositories/cache"
import type { UsageRepository, UsageEntry } from "../db/repositories/usage"

const ESTIMATE: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
  needsClarification: false,
  confidence: "high",
}

class FakeUsageRepo {
  rows: UsageEntry[] = []
  record(entry: UsageEntry) {
    this.rows.push(entry)
  }
}

class FakeCacheRepo {
  store = new Map<string, EstimationResult>()
  get(key: string) {
    return this.store.get(key) ?? null
  }
  set(key: string, value: EstimationResult) {
    this.store.set(key, value)
  }
}

function fakeProvider(result: ProviderResult | Error): AIProvider {
  return {
    name: "openai",
    estimate: async () => {
      if (result instanceof Error) throw result
      return result
    },
  }
}

const OK_RESULT: ProviderResult = {
  estimate: ESTIMATE,
  usage: {
    model: "gpt-5.6-luna",
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 0,
  },
}

let usage: FakeUsageRepo
let cache: FakeCacheRepo
let service: AIService

/** Installs a fake provider, bypassing the config-driven provider map. */
function build(provider: AIProvider): AIService {
  const s = new AIService(
    cache as unknown as CacheRepository,
    usage as unknown as UsageRepository
  )
  // @ts-expect-error - reaching into the private provider map for testing
  s.providers.set("openai", provider)
  return s
}

beforeEach(() => {
  usage = new FakeUsageRepo()
  cache = new FakeCacheRepo()
})

const OPTS = { telegramId: 42, chatId: -100, callType: "estimate" as const }

describe("usage recording", () => {
  test("writes one row on a live call", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows).toHaveLength(1)
    const row = usage.rows[0]
    expect(row.telegramId).toBe(42)
    expect(row.chatId).toBe(-100)
    expect(row.provider).toBe("openai")
    expect(row.model).toBe("gpt-5.6-luna")
    expect(row.inputTokens).toBe(1000)
    expect(row.outputTokens).toBe(100)
    expect(row.callType).toBe("estimate")
    expect(row.status).toBe("ok")
    // 1000 * 0.20/1e6 + 100 * 1.20/1e6
    expect(row.costUsd).toBeCloseTo((1000 * 0.2 + 100 * 1.2) / 1_000_000, 12)
  })

  test("writes no row on a cache hit", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(fakeProvider(OK_RESULT))

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result).toEqual(ESTIMATE)
    expect(usage.rows).toHaveLength(0)
  })

  test("records status no_usage when the provider reports zero tokens", async () => {
    service = build(
      fakeProvider({
        estimate: ESTIMATE,
        usage: { model: "gpt-5.6-luna", inputTokens: 0, outputTokens: 0 },
      })
    )
    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows[0].status).toBe("no_usage")
  })

  test("records a parse_error row when the provider throws a SyntaxError", async () => {
    service = build(fakeProvider(new SyntaxError("Unexpected token }")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0].status).toBe("parse_error")
  })

  test("writes no row when the HTTP call itself fails", async () => {
    service = build(fakeProvider(new Error("503 Service Unavailable")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()
    expect(usage.rows).toHaveLength(0)
  })

  test("a failing usage write never breaks estimation", async () => {
    const exploding = {
      record() {
        throw new Error("disk full")
      },
    }
    const s = new AIService(
      cache as unknown as CacheRepository,
      exploding as unknown as UsageRepository
    )
    // @ts-expect-error - private map
    s.providers.set("openai", fakeProvider(OK_RESULT))

    const result = await s.estimate("chicken adobo", "openai", OPTS)
    expect(result).toEqual(ESTIMATE)
  })

  test("passes context through and marks the call type", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("200g", "openai", {
      telegramId: 1,
      chatId: 2,
      callType: "clarify",
      context: "earlier: grilled chicken",
    })

    expect(usage.rows[0].callType).toBe("clarify")
  })

  test("does not cache when context is present", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("200g", "openai", { ...OPTS, context: "earlier: chicken" })

    expect(cache.store.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test src/ai/service.test.ts
```

Expected: FAIL — `estimate` does not yet accept an options object and records nothing.

- [ ] **Step 3: Implement recording**

Rewrite the `estimate` and `estimateWithProvider` methods in `src/ai/service.ts`:

```typescript
import { calculateCost } from "./pricing"
import type { CallType, UsageStatus, TokenUsage } from "./types"

export interface EstimateOptions {
  telegramId: number
  chatId: number | null
  callType: CallType
  context?: string
}

  async estimate(
    foodDescription: string,
    providerName: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    const normalizedFood = this.normalizeFood(foodDescription)

    if (!opts.context && config.features.caching) {
      const cached = this.cache.get(normalizedFood)
      if (cached) return cached   // nothing billed, nothing recorded
    }

    const provider = this.providers.get(providerName) ?? this.providers.values().next().value
    if (!provider) {
      throw new Error("No AI provider configured")
    }

    return this.estimateWithProvider(provider, foodDescription, normalizedFood, opts)
  }

  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    let result
    try {
      result = await provider.estimate(foodDescription, opts.context)
    } catch (error) {
      // A JSON parse failure means the API replied and billed us, but the body
      // was unusable. Any other error means no usable response at all, so there
      // is nothing to attribute.
      if (error instanceof SyntaxError) {
        this.recordSafely(provider.name, { model: "unknown", inputTokens: 0, outputTokens: 0 }, opts, "parse_error")
      }
      throw error
    }

    const status: UsageStatus =
      result.usage.inputTokens === 0 && result.usage.outputTokens === 0 ? "no_usage" : "ok"
    this.recordSafely(provider.name, result.usage, opts, status)

    const estimate = result.estimate
    if (!estimate.needsClarification && !opts.context && config.features.caching) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }

  /** Accounting must never break calorie logging. */
  private recordSafely(
    providerName: string,
    usage: TokenUsage,
    opts: EstimateOptions,
    status: UsageStatus
  ): void {
    try {
      this.usage.record({
        telegramId: opts.telegramId,
        chatId: opts.chatId,
        provider: providerName,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens ?? null,
        costUsd: calculateCost(usage),
        callType: opts.callType,
        status,
      })
    } catch (error) {
      console.error("[usage] Failed to record AI usage:", error)
    }
  }
```

The `parse_error` path records `model: "unknown"` with zero tokens, because a thrown `SyntaxError` carries no usage data. That row exists to make failures visible and costs 0 — the spec's "billed but wasted" case is only fully recoverable when a provider surfaces usage alongside a parse failure, which none currently do.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/ai/service.test.ts
```

Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/service.ts src/ai/service.test.ts
git commit -m "feat(ai): record per-call token usage and cost"
```

---

### Task 7: Update the four call sites

**Files:**
- Modify: `src/bot/conversations/log-flow.ts:148,171`
- Modify: `src/bot/commands/edit.ts:148`
- Modify: `src/jobs/retry-pending.ts:64`
- Modify: `src/bot/conversations/log-flow.test.ts:151`
- Test: `src/jobs/retry-pending.test.ts` (create)

**Interfaces:**
- Consumes: `estimate(food, provider, opts)` (Task 6)
- Produces: nothing

- [ ] **Step 1: Update `log-flow.ts`**

`handleAwaitingInput` (line ~148):

```typescript
      const result = await this.aiService.estimate(input, provider, {
        telegramId,
        chatId,
        callType: "estimate",
      })
```

`handleClarifying` (line ~171):

```typescript
      const result = await this.aiService.estimate(input, provider, {
        telegramId,
        chatId,
        callType: "clarify",
        context: contextStr,
      })
```

Both methods already take `telegramId` and `chatId` as parameters.

- [ ] **Step 2: Update the existing log-flow assertion**

`src/bot/conversations/log-flow.test.ts:151` currently asserts the old positional form. Replace:

```typescript
    expect(mockAIService.estimate).toHaveBeenCalledWith(
      "200g grilled",
      "openai",
      expect.objectContaining({
        callType: "clarify",
        context: expect.stringContaining("chicken"),
      })
    )
```

- [ ] **Step 3: Update `edit.ts`**

At line ~148, `userId` is in scope but `chatId` is not:

```typescript
          const result = await aiService.estimate(text, provider, {
            telegramId: userId,
            chatId: ctx.chat?.id ?? null,
            callType: "edit",
          })
```

- [ ] **Step 4: Update `retry-pending.ts`**

At line ~64:

```typescript
        const result = await aiService.estimate(entry.food_text, provider, {
          telegramId: entry.telegram_id,
          chatId: entry.chat_id,
          callType: "retry",
        })
```

- [ ] **Step 5: Run the suite**

```bash
bunx tsc --noEmit
bun test
```

Expected: no type errors; `log-flow.test.ts` passes with the updated assertion. If any call site still compiles without an options object, you missed one — `telegramId` is required precisely so this cannot happen silently.

- [ ] **Step 6: Write the retry-pending test**

`retry-pending.ts` is a background job with zero coverage, and its failures are never seen interactively. Create `src/jobs/retry-pending.test.ts`:

```typescript
// src/jobs/retry-pending.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../db/test-helpers"
import { PendingRepository } from "../db/repositories/pending"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { createRetryPendingJob } from "./retry-pending"
import type { AIService } from "../ai/service"

let db: Database

beforeEach(() => {
  db = createTestDb()
})

test("passes retry call type and the entry's user and chat to the AI service", async () => {
  const pendingRepo = new PendingRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(42, "ray")
  pendingRepo.create(42, -100, "chicken adobo", "2026-09-21")

  const estimate = mock(() =>
    Promise.resolve({
      items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high" as const,
    })
  )
  const bot = { api: { sendMessage: mock(() => Promise.resolve()) } }

  // createRetryPendingJob returns the single-pass async function that the
  // interval in startRetryPendingJob calls. Invoke it directly — never test
  // by waiting on a timer.
  const job = createRetryPendingJob(
    bot as any,
    pendingRepo,
    foodLogsRepo,
    usersRepo,
    { estimate } as unknown as AIService
  )
  await job()

  expect(estimate).toHaveBeenCalledWith(
    "chicken adobo",
    expect.any(String),
    expect.objectContaining({ telegramId: 42, chatId: -100, callType: "retry" })
  )
})
```

`createRetryPendingJob` is already exported at `src/jobs/retry-pending.ts:33` and returns an `async (): Promise<void>` — no extraction is needed. `startRetryPendingJob` merely wraps it in a `setInterval`.

- [ ] **Step 7: Run it**

```bash
bun test src/jobs/retry-pending.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/bot/conversations/log-flow.ts src/bot/conversations/log-flow.test.ts src/bot/commands/edit.ts src/jobs/retry-pending.ts src/jobs/retry-pending.test.ts
git commit -m "feat(bot): attribute AI calls to users at every call site"
```

---

### Task 8: Add the `/usage` command

**Files:**
- Create: `src/utils/format.ts`
- Test: `src/utils/format.test.ts`
- Create: `src/bot/commands/usage.ts`
- Test: `src/bot/commands/usage.test.ts`
- Modify: `src/bot/index.ts` (register the command)

**Interfaces:**
- Consumes: `UsageRepository.getUserTotals` (Task 3)
- Produces:
  - `formatUsd(amount: number): string`
  - `formatTokens(n: number): string`
  - `formatUserUsage(totals: UsageTotals, days: number): string`
  - `createUsageCommand(usageRepo: UsageRepository)`

- [ ] **Step 1: Write the failing formatter test**

Create `src/utils/format.test.ts`:

```typescript
// src/utils/format.test.ts
import { describe, test, expect } from "bun:test"
import { formatUsd, formatTokens } from "./format"

describe("formatUsd", () => {
  test("uses two decimals at or above one cent", () => {
    expect(formatUsd(1.844)).toBe("$1.84")
    expect(formatUsd(0.01)).toBe("$0.01")
  })

  test("uses four decimals below one cent, so small spend is not rendered as zero", () => {
    expect(formatUsd(0.0043)).toBe("$0.0043")
    expect(formatUsd(0.000078)).toBe("$0.0001")
  })

  test("renders a true zero plainly", () => {
    expect(formatUsd(0)).toBe("$0.00")
  })
})

describe("formatTokens", () => {
  test("groups thousands below 10k", () => {
    expect(formatTokens(21300)).toBe("21,300")
    expect(formatTokens(950)).toBe("950")
  })

  test("abbreviates at and above 100k", () => {
    expect(formatTokens(186200)).toBe("186.2k")
    expect(formatTokens(1500000)).toBe("1500.0k")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test src/utils/format.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the formatters**

Create `src/utils/format.ts`:

```typescript
// src/utils/format.ts

/**
 * A single AI call costs roughly $0.0002, so two-decimal formatting would
 * render a light month as "$0.00" — which reads as broken rather than cheap.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString("en-US")
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test src/utils/format.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Write the failing command test**

Create `src/bot/commands/usage.test.ts`:

```typescript
// src/bot/commands/usage.test.ts
import { describe, test, expect } from "bun:test"
import { formatUserUsage } from "./usage"

describe("formatUserUsage", () => {
  test("shows calls and tokens but never a dollar figure", () => {
    const message = formatUserUsage(
      { calls: 47, inputTokens: 21300, outputTokens: 4800, costUsd: 0.12 },
      30
    )

    expect(message).toContain("47 calls")
    expect(message).toContain("21,300")
    expect(message).toContain("4,800")
    expect(message).toContain("last 30 days")
    expect(message).not.toContain("$")
  })

  test("shows an empty state rather than a row of zeroes", () => {
    const message = formatUserUsage(
      { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      30
    )

    expect(message).not.toContain("0 calls")
    expect(message.toLowerCase()).toContain("no ai usage")
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

```bash
bun test src/bot/commands/usage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Write the command**

Create `src/bot/commands/usage.ts`:

```typescript
// src/bot/commands/usage.ts
import { Context } from "grammy"
import { UsageRepository, type UsageTotals } from "../../db/repositories/usage"
import { formatTokens } from "../../utils/format"
import { smartReply } from "../utils/smart-reply"

const WINDOW_DAYS = 30

/**
 * Deliberately shows no cost. Dollar figures are admin-only — see the
 * design doc's Decisions table.
 */
export function formatUserUsage(totals: UsageTotals, days: number): string {
  if (totals.calls === 0) {
    return `📊 No AI usage recorded in the last ${days} days.`
  }

  return (
    `📊 Your AI usage — last ${days} days\n` +
    `${totals.calls} calls · ${formatTokens(totals.inputTokens)} in / ` +
    `${formatTokens(totals.outputTokens)} out tokens`
  )
}

export function createUsageCommand(usageRepo: UsageRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const totals = usageRepo.getUserTotals(userId, WINDOW_DAYS)
    await smartReply(ctx, formatUserUsage(totals, WINDOW_DAYS))
  }
}
```

- [ ] **Step 8: Register the command**

In `src/bot/index.ts`, construct the repository once and register alongside the other commands:

```typescript
  const usageRepo = new UsageRepository(db)
  const aiService = new AIService(new CacheRepository(db), usageRepo)
  // ...
  bot.command("usage", createUsageCommand(usageRepo))
```

Reuse the same `usageRepo` instance for `AIService` rather than constructing a second one.

- [ ] **Step 9: Run the tests**

```bash
bun test src/bot/commands/usage.test.ts
bunx tsc --noEmit
bun test
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts src/bot/commands/usage.ts src/bot/commands/usage.test.ts src/bot/index.ts
git commit -m "feat(bot): add /usage showing a user's own token footprint"
```

---

### Task 9: Add the `/admin usage` subcommand

**Files:**
- Modify: `src/bot/commands/admin.ts`
- Test: `src/bot/commands/admin-usage.test.ts` (create)

**Interfaces:**
- Consumes: `UsageRepository.getAllUserTotals`, `getModelBreakdown` (Task 3); `formatUsd`, `formatTokens` (Task 8)
- Produces: `formatAdminUsage(users, models, days): string`; `createAdminCommand(repo, usageRepo)`

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/admin-usage.test.ts`:

```typescript
// src/bot/commands/admin-usage.test.ts
import { describe, test, expect } from "bun:test"
import { formatAdminUsage, parseUsageWindow } from "./admin"
import type { UserUsageRow, ModelUsageRow } from "../../db/repositories/usage"

function user(over: Partial<UserUsageRow>): UserUsageRow {
  return {
    telegramId: 1,
    username: null,
    calls: 10,
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 0.01,
    ...over,
  }
}

describe("parseUsageWindow", () => {
  test("defaults to 30 days", () => {
    expect(parseUsageWindow(undefined)).toBe(30)
  })

  test("accepts 7d, 30d and all", () => {
    expect(parseUsageWindow("7d")).toBe(7)
    expect(parseUsageWindow("30d")).toBe(30)
    expect(parseUsageWindow("all")).toBe(0)
  })

  test("falls back to 30 days for anything else", () => {
    expect(parseUsageWindow("banana")).toBe(30)
  })
})

describe("formatAdminUsage", () => {
  const models: ModelUsageRow[] = [
    { model: "gpt-5.6-luna", calls: 320, inputTokens: 100, outputTokens: 10, costUsd: 1.12 },
  ]

  test("shows totals, per-user rows with dollars, and the model breakdown", () => {
    const users = [
      user({ telegramId: 123456789, username: "ray", costUsd: 0.91, calls: 205 }),
      user({ telegramId: 987654321, costUsd: 0.63, calls: 140 }),
    ]

    const message = formatAdminUsage(users, models, 30)

    expect(message).toContain("last 30 days")
    expect(message).toContain("$1.54")            // 0.91 + 0.63
    expect(message).toContain("345 calls")        // 205 + 140
    expect(message).toContain("123456789 (@ray)")
    expect(message).toContain("987654321")
    expect(message).toContain("gpt-5.6-luna")
  })

  test("caps the user list at ten and summarises the remainder", () => {
    const users = Array.from({ length: 13 }, (_, i) =>
      user({ telegramId: i + 1, costUsd: (13 - i) / 100 })
    )

    const message = formatAdminUsage(users, models, 30)
    const bulletCount = (message.match(/^• /gm) ?? []).length

    expect(bulletCount).toBe(11)                   // 10 users + 1 model row
    expect(message).toContain("and 3 more")
  })

  test("shows an empty state when nothing is recorded", () => {
    expect(formatAdminUsage([], [], 30).toLowerCase()).toContain("no ai usage")
  })

  test("labels the all-time window", () => {
    expect(formatAdminUsage([user({})], models, 0)).toContain("all time")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test src/bot/commands/admin-usage.test.ts
```

Expected: FAIL — `parseUsageWindow` and `formatAdminUsage` are not exported.

- [ ] **Step 3: Implement the subcommand**

In `src/bot/commands/admin.ts`, add the imports, the two exported helpers, and a `usage` case.

```typescript
import { UsageRepository, type UserUsageRow, type ModelUsageRow } from "../../db/repositories/usage"
import { formatUsd, formatTokens } from "../../utils/format"

const MAX_USER_ROWS = 10

export function parseUsageWindow(arg: string | undefined): number {
  switch (arg?.toLowerCase()) {
    case "7d":
      return 7
    case "all":
      return 0
    default:
      return 30
  }
}

export function formatAdminUsage(
  users: UserUsageRow[],
  models: ModelUsageRow[],
  days: number
): string {
  const label = days === 0 ? "all time" : `last ${days} days`

  if (users.length === 0) {
    return `📊 No AI usage recorded — ${label}.`
  }

  const totalCost = users.reduce((sum, u) => sum + u.costUsd, 0)
  const totalCalls = users.reduce((sum, u) => sum + u.calls, 0)
  const totalIn = users.reduce((sum, u) => sum + u.inputTokens, 0)
  const totalOut = users.reduce((sum, u) => sum + u.outputTokens, 0)

  let message = `📊 AI Usage — ${label}\n`
  message += `Total: ${formatUsd(totalCost)} · ${totalCalls} calls · `
  message += `${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out\n\n`

  message += "By user:\n"
  const shown = users.slice(0, MAX_USER_ROWS)
  for (const u of shown) {
    const name = u.username ? ` (@${u.username})` : ""
    message += `• ${u.telegramId}${name} — ${formatUsd(u.costUsd)} · ${u.calls} calls\n`
  }

  // Telegram caps messages at 4096 characters and this bot has no shared
  // guard, so this command caps its own list rather than risk a silent failure.
  const rest = users.slice(MAX_USER_ROWS)
  if (rest.length > 0) {
    const restCost = rest.reduce((sum, u) => sum + u.costUsd, 0)
    message += `…and ${rest.length} more (${formatUsd(restCost)} total)\n`
  }

  if (models.length > 0) {
    message += "\nBy model:\n"
    for (const m of models) {
      message += `• ${m.model} — ${formatUsd(m.costUsd)} · ${m.calls} calls\n`
    }
  }

  return message.trimEnd()
}
```

Change the factory signature and add the case:

```typescript
export function createAdminCommand(repo: AllowedUsersRepository, usageRepo: UsageRepository) {
```

```typescript
      case "usage": {
        const days = parseUsageWindow(args[1])
        const users = usageRepo.getAllUserTotals(days)
        const models = usageRepo.getModelBreakdown(days)
        await smartReply(ctx, formatAdminUsage(users, models, days))
        break
      }
```

And extend the no-subcommand help text at `admin.ts:19-27`:

```typescript
      await smartReply(ctx,
        "Admin commands:\n" +
          "/admin add <user_id>\n" +
          "/admin remove <user_id>\n" +
          "/admin list\n" +
          "/admin usage [7d|30d|all]"
      )
```

- [ ] **Step 4: Update the registration**

In `src/bot/index.ts`:

```typescript
  bot.command("admin", createAdminCommand(allowedUsersRepo, usageRepo))
```

- [ ] **Step 5: Run the tests**

```bash
bun test src/bot/commands/admin-usage.test.ts
bunx tsc --noEmit
bun test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/admin.ts src/bot/commands/admin-usage.test.ts src/bot/index.ts
git commit -m "feat(admin): add /admin usage with per-user and per-model cost"
```

---

### Task 10: Discoverability, end-to-end verification, and handoff

**Files:**
- Modify: `src/bot/index.ts` (the `/start` help text)
- Modify: `README.md` (the Bot Commands table)

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Add `/usage` to the `/start` help text**

In `src/bot/index.ts:45-60`, insert after the `/pending` line:

```typescript
        "/pending - View pending estimations\n" +
        "/usage - See your AI token usage\n" +
        "/settings - Change preferences\n\n" +
```

`bot.api.setMyCommands` is not called anywhere in this repo, so Telegram's autocomplete menu needs no change.

- [ ] **Step 2: Add `/usage` to the README table**

In `README.md:74-87`, add a row before the `/admin` row:

```markdown
| `/usage` | View your own AI token usage |
```

And update the `/admin` row's description to mention the new subcommand:

```markdown
| `/admin` | Manage allowed users, view AI usage and cost (admin only) |
```

- [ ] **Step 3: Full verification**

```bash
bunx tsc --noEmit
bun test
```

Expected: every test passes. Record the total count.

- [ ] **Step 4: End-to-end check against a real database**

```bash
bun -e '
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
const db = new Database(":memory:")
db.run(readFileSync("src/db/schema.sql", "utf-8"))
const { UsageRepository } = await import("./src/db/repositories/usage.ts")
const repo = new UsageRepository(db)
repo.record({
  telegramId: 1, chatId: 2, provider: "openai", model: "gpt-5.6-luna",
  inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0,
  outputTokens: 100, reasoningTokens: 0, costUsd: 0.00032,
  callType: "estimate", status: "ok",
})
console.log(repo.getUserTotals(1, 30))
console.log(repo.getAllUserTotals(30))
console.log(repo.getModelBreakdown(30))
'
```

Expected: totals of 1 call, 1000 in, 100 out, cost 0.00032, and one row in each breakdown.

- [ ] **Step 5: Live end-to-end check**

Start the bot against a real database and, in Telegram:

1. Run `/log` and log a food item, confirming the estimate.
2. Run `/usage` — it must show at least 1 call with non-zero tokens and **no dollar sign**.
3. Run `/admin usage` — it must show a dollar total, your user row, and the model you used.
4. Run `/log` again with the **exact same food text** and confirm it, then re-run `/usage` — the call count must be **unchanged**, proving cache hits record nothing.
5. Run `/admin usage 7d` and `/admin usage all` and confirm both render.

Record the output of each step.

- [ ] **Step 6: Review the full diff**

```bash
git diff refactor/openai-responses-api --stat
```

Confirm no file outside this plan's scope changed, and that the eight pre-existing test files (other than `log-flow.test.ts`) are untouched.

- [ ] **Step 7: Commit and report**

```bash
git add src/bot/index.ts README.md
git commit -m "docs: surface /usage in help text and README"
```

Report: the full test count, the end-to-end outputs from Step 5, the live `usage` values observed per provider, and any place the implementation had to diverge from this plan.

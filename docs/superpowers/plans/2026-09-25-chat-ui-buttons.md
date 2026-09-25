# Chat UI Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace width-dependent `─` separators with a quote-box summary, and replace typed yes/no at the `/log` and `/delete` confirm steps with inline buttons that can only act on the exact estimate or item their message shows, for the user it was sent to.

**Architecture:**
- Pure helpers carry the formatting and button payloads: `format.ts` holds the HTML summary and hash, and `callback-data.ts` holds the button-data formats.
- `LogFlow` stays grammY-free. It returns a `confirm` token with its confirmation messages, and exposes `resolveConfirmation` for button presses. The typed path shares its state transitions.
- The bot layer builds the keyboards and handles presses. It checks the owner first, then staleness, then edits the message in place.

**Tech Stack:** Bun, TypeScript, grammY 1.39, `bun:sqlite`, `bun:test`

**Spec:** `docs/superpowers/specs/2026-09-25-chat-ui-buttons-design.md`

## Global Constraints

- Work on branch `feat/chat-ui-buttons`. It already exists and holds the spec commit `f42ecae`.
- **Never `git add -A` or `git add .`.** The working tree holds the user's uncommitted edits to `CLAUDE.md` and `docs/agents/`, and they must not be committed. Stage only the files each task names. Do not modify `CLAUDE.md`.
- Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Baseline before Task 1: `bun test` → **132 pass, 0 fail across 22 files**, and `bunx tsc --noEmit` exits 0 with no output. `tsc` includes test files (`tsconfig.json` includes `src/**/*`), so tests must type-check too.
- Callback data formats, exactly:
  - `log:<ok|chg|cxl>:<ownerId>:<token>`
  - `del:one:<ownerId>:<itemId>`
  - `del:all:<ownerId>:<YYYY-MM-DD>:<token>`
  - `del:cxl:<ownerId>`
  
  Every value must be at most 64 bytes, which is Telegram's limit.
- Tokens are `shortHash(...)`: the first 8 lowercase hex characters of SHA-256.
  - `/log` token: `` shortHash(`${target_date}|${pending_items}`) ``, where `pending_items` is the exact JSON string stored in `conversation_state`.
  - `/delete` all token: `shortHash` of the day's item ids, sorted ascending and joined with `,`.
- Send `parse_mode: "HTML"` **only** on messages that contain `formatItemsSummary` output. Every interpolated string in those messages is escaped with `escapeHtml`. The first line of an HTML message contains no markup, because `smartReply` inserts the user's name into it.
- `/delete` messages stay plain text, with no `parse_mode`.
- Typed replies keep working: "yes"/"y", "no"/"n" and "cancel" at the `/log` confirm step; "yes"/"y" and "cancel" at the `/delete` confirm step.
- User-facing copy is fixed by the spec. Use these strings verbatim:
  - `✅ Log {total} cal`, `✏️ Change`, `✖️ Cancel`, `🗑 Delete`, `🗑 Delete all`
  - `✅ Logged to {Fri, Sep 25}:`, `✏️ Not logged — changing:`, `✖️ Cancelled — not logged:`
  - `Okay, let's try again. What did you eat?`
  - `🗑 Deleted: {emoji} {description} — {calories} cal`
  - `🗑 Deleted {n} entries ({total} cal) for {Fri, Sep 25}.`
  - `✖️ Cancelled — nothing deleted.`
  - Toasts: `Logged ✅`, `Cancelled`, `Deleted`
  - `Only the person who started this can confirm it.`
  - `That entry is no longer pending.`
  - `That entry is no longer there.`
  - `The list changed — run /delete again.`
  - `That button has expired.`
  - `Tap a button above, or reply "yes" / "no".` (`/log`)
  - `Tap a button above, or reply "yes" / "cancel".` (`/delete`)
- Dates in the new copy use `formatDateForDisplay` from `src/utils/dates.ts`, e.g. `2026-01-31` → `Sat, Jan 31`.
- New test files use `createTestDb()` from `src/db/test-helpers.ts` whenever they need the database. **Do not retrofit** the hand-copied schemas in existing test files.

---

### Task 1: HTML summary, escaping and short hash

The four copies of the item-line mapping and the `─` rule get one replacement. `shortHash` is the fingerprint primitive that Tasks 4 and 6 build tokens from.

**Files:**
- Modify: `src/utils/format.ts` (append)
- Test: `src/utils/format.test.ts` (append; update the import line)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `escapeHtml(text: string): string`
  - `interface SummaryItem { description: string; calories: number; emoji?: string | null }`
  - `formatItemsSummary(items: SummaryItem[], opts?: { struck?: boolean }): string`
  - `shortHash(text: string): string`

- [ ] **Step 1: Write the failing tests**

In `src/utils/format.test.ts`, change the import line to:

```ts
import { formatUsd, formatTokens, escapeHtml, formatItemsSummary, shortHash } from "./format"
```

Append:

```ts
describe("escapeHtml", () => {
  test("escapes the three characters Telegram's HTML mode requires", () => {
    expect(escapeHtml("mac & cheese <3 >_<")).toBe("mac &amp; cheese &lt;3 &gt;_&lt;")
  })

  test("leaves quotes and apostrophes alone", () => {
    expect(escapeHtml(`Here's "it"`)).toBe(`Here's "it"`)
  })
})

describe("formatItemsSummary", () => {
  const items = [
    { description: "2 scrambled eggs", calories: 180, emoji: "🍳" },
    { description: "Black coffee", calories: 5, emoji: "☕" },
  ]

  test("puts items in a blockquote with a bold total beneath", () => {
    expect(formatItemsSummary(items)).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</blockquote>\n" +
        "<b>Total: 185 cal</b>"
    )
  })

  test("escapes descriptions", () => {
    const out = formatItemsSummary([{ description: "Mac & cheese", calories: 400, emoji: "🧀" }])
    expect(out).toContain("🧀 Mac &amp; cheese — 400 cal")
  })

  test("falls back to 🍽️ when an item has no emoji", () => {
    expect(formatItemsSummary([{ description: "Rice", calories: 200 }])).toContain("🍽️ Rice — 200 cal")
    expect(formatItemsSummary([{ description: "Rice", calories: 200, emoji: null }])).toContain(
      "🍽️ Rice — 200 cal"
    )
  })

  test("strikes through items and total when struck", () => {
    expect(formatItemsSummary(items, { struck: true })).toBe(
      "<blockquote><s>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</s></blockquote>\n" +
        "<b><s>Total: 185 cal</s></b>"
    )
  })

  test("contains no width-dependent rule", () => {
    expect(formatItemsSummary(items)).not.toContain("─")
  })
})

describe("shortHash", () => {
  test("is 8 lowercase hex characters", () => {
    expect(shortHash("anything")).toMatch(/^[0-9a-f]{8}$/)
  })

  test("is deterministic", () => {
    expect(shortHash("2026-09-25|[]")).toBe(shortHash("2026-09-25|[]"))
  })

  test("differs for different input", () => {
    expect(shortHash("a")).not.toBe(shortHash("b"))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/utils/format.test.ts`
Expected: FAIL. `escapeHtml`, `formatItemsSummary` and `shortHash` are not exported. The new `describe` blocks error, and the existing `formatUsd`/`formatTokens` tests are unaffected.

- [ ] **Step 3: Implement**

Add at the top of `src/utils/format.ts`, above the existing comment:

```ts
import { createHash } from "node:crypto"
```

Append to the end of `src/utils/format.ts`:

```ts
/** Escapes text for Telegram's HTML parse mode, which only requires these three. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export interface SummaryItem {
  description: string
  calories: number
  emoji?: string | null
}

/**
 * Items in a quote box with a bold total beneath, for messages sent with
 * parse_mode "HTML". This replaces a row of ─ characters, which wrapped onto a
 * second line on narrow screens: no character count fits every client, and a
 * blockquote does not depend on width at all.
 */
export function formatItemsSummary(items: SummaryItem[], opts: { struck?: boolean } = {}): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items
    .map((item) => `${escapeHtml(item.emoji ?? "🍽️")} ${escapeHtml(item.description)} — ${item.calories} cal`)
    .join("\n")
  const total = items.reduce((sum, item) => sum + item.calories, 0)
  return `<blockquote>${strike(lines)}</blockquote>\n<b>${strike(`Total: ${total} cal`)}</b>`
}

/** First 8 hex characters of SHA-256 — short enough for 64-byte button data. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/utils/format.test.ts`
Expected: PASS, with 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts
git commit -m "$(cat <<'EOF'
feat(format): add HTML item summary, escaping and short hash

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Callback data formats

These are pure encode/parse functions for the new button payloads. Parsing validates everything, because a press may come from an old or malformed message.

**Files:**
- Create: `src/bot/utils/callback-data.ts`
- Test: `src/bot/utils/callback-data.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LogAction = "ok" | "chg" | "cxl"`
  - `interface LogCallback { action: LogAction; ownerId: number; token: string }`
  - `type DeleteCallback = { action: "one"; ownerId: number; itemId: number } | { action: "all"; ownerId: number; date: string; token: string } | { action: "cxl"; ownerId: number }`
  - `encodeLogCallback(cb: LogCallback): string`
  - `parseLogCallback(data: string): LogCallback | null`
  - `encodeDeleteCallback(cb: DeleteCallback): string`
  - `parseDeleteCallback(data: string): DeleteCallback | null`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/utils/callback-data.test.ts`:

```ts
// src/bot/utils/callback-data.test.ts
import { describe, test, expect } from "bun:test"
import {
  encodeLogCallback,
  parseLogCallback,
  encodeDeleteCallback,
  parseDeleteCallback,
  LogCallback,
  DeleteCallback,
} from "./callback-data"

// The largest integer a JS number holds exactly. Real Telegram ids are shorter,
// so this is the worst case for the 64-byte limit.
const BIG_ID = Number.MAX_SAFE_INTEGER

describe("log callback data", () => {
  test("round-trips every action", () => {
    for (const action of ["ok", "chg", "cxl"] as const) {
      const cb: LogCallback = { action, ownerId: 42, token: "abcd1234" }
      expect(parseLogCallback(encodeLogCallback(cb))).toEqual(cb)
    }
  })

  test("encodes to the documented format", () => {
    expect(encodeLogCallback({ action: "ok", ownerId: 42, token: "abcd1234" })).toBe("log:ok:42:abcd1234")
  })

  test("rejects malformed data", () => {
    for (const data of [
      "log:ok:42",
      "log:ok:42:abcd1234:extra",
      "log:yes:42:abcd1234",
      "log:ok:abc:abcd1234",
      "log:ok:-1:abcd1234",
      "log:ok:42:ABCD1234",
      "log:ok:42:abc",
      "settings:provider",
      "",
    ]) {
      expect(parseLogCallback(data)).toBeNull()
    }
  })

  test("stays within Telegram's 64-byte limit", () => {
    const data = encodeLogCallback({ action: "cxl", ownerId: BIG_ID, token: "abcd1234" })
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  })
})

describe("delete callback data", () => {
  const cases: DeleteCallback[] = [
    { action: "one", ownerId: 42, itemId: 7 },
    { action: "all", ownerId: 42, date: "2026-09-25", token: "abcd1234" },
    { action: "cxl", ownerId: 42 },
  ]

  test("round-trips every action", () => {
    for (const cb of cases) {
      expect(parseDeleteCallback(encodeDeleteCallback(cb))).toEqual(cb)
    }
  })

  test("encodes to the documented formats", () => {
    expect(cases.map((cb) => encodeDeleteCallback(cb))).toEqual([
      "del:one:42:7",
      "del:all:42:2026-09-25:abcd1234",
      "del:cxl:42",
    ])
  })

  test("rejects malformed data", () => {
    for (const data of [
      "del:one:42",
      "del:one:42:x",
      "del:all:42:2026-9-25:abcd1234",
      "del:all:42:2026-09-25",
      "del:cxl:42:7",
      "del:zap:42",
      "del:one:abc:7",
      "log:ok:42:abcd1234",
      "",
    ]) {
      expect(parseDeleteCallback(data)).toBeNull()
    }
  })

  test("stays within Telegram's 64-byte limit", () => {
    const data = encodeDeleteCallback({ action: "all", ownerId: BIG_ID, date: "2026-09-25", token: "abcd1234" })
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/bot/utils/callback-data.test.ts`
Expected: FAIL with a module-not-found error for `./callback-data`.

- [ ] **Step 3: Implement**

Create `src/bot/utils/callback-data.ts`:

```ts
// src/bot/utils/callback-data.ts
// Payload formats for the /log and /delete confirmation buttons. Every button
// carries the id of the user it was sent to: in a group chat anyone can press
// any keyboard, and ctx.from is the presser, not the owner. Telegram caps
// callback data at 64 bytes.

export type LogAction = "ok" | "chg" | "cxl"

export interface LogCallback {
  action: LogAction
  ownerId: number
  token: string
}

export type DeleteCallback =
  | { action: "one"; ownerId: number; itemId: number }
  | { action: "all"; ownerId: number; date: string; token: string }
  | { action: "cxl"; ownerId: number }

const TOKEN = /^[0-9a-f]{8}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function parseId(text: string | undefined): number | null {
  if (!text || !/^\d+$/.test(text)) return null
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : null
}

export function encodeLogCallback(cb: LogCallback): string {
  return `log:${cb.action}:${cb.ownerId}:${cb.token}`
}

export function parseLogCallback(data: string): LogCallback | null {
  const parts = data.split(":")
  if (parts.length !== 4 || parts[0] !== "log") return null

  const [, action, owner, token] = parts
  if (action !== "ok" && action !== "chg" && action !== "cxl") return null

  const ownerId = parseId(owner)
  if (ownerId === null || !TOKEN.test(token)) return null

  return { action, ownerId, token }
}

export function encodeDeleteCallback(cb: DeleteCallback): string {
  switch (cb.action) {
    case "one":
      return `del:one:${cb.ownerId}:${cb.itemId}`
    case "all":
      return `del:all:${cb.ownerId}:${cb.date}:${cb.token}`
    case "cxl":
      return `del:cxl:${cb.ownerId}`
  }
}

export function parseDeleteCallback(data: string): DeleteCallback | null {
  const parts = data.split(":")
  if (parts[0] !== "del") return null

  const ownerId = parseId(parts[2])
  if (ownerId === null) return null

  switch (parts[1]) {
    case "one": {
      if (parts.length !== 4) return null
      const itemId = parseId(parts[3])
      return itemId === null ? null : { action: "one", ownerId, itemId }
    }
    case "all": {
      if (parts.length !== 5 || !DATE.test(parts[3]) || !TOKEN.test(parts[4])) return null
      return { action: "all", ownerId, date: parts[3], token: parts[4] }
    }
    case "cxl":
      return parts.length === 3 ? { action: "cxl", ownerId } : null
    default:
      return null
  }
}
```

- [ ] **Step 4: Run the tests and the type check to verify they pass**

Run: `bun test src/bot/utils/callback-data.test.ts && bunx tsc --noEmit`
Expected: PASS, with 0 fail. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/bot/utils/callback-data.ts src/bot/utils/callback-data.test.ts
git commit -m "$(cat <<'EOF'
feat(bot): add callback data formats for confirmation buttons

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: HTML-safe personalization and `smartEdit`

`smartReply` inserts the user's first name in group chats. Under HTML parse mode, a name like `Tom & Jerry` breaks the message, so the name must be escaped. Button presses edit their message instead of replying, so they need the same personalization on edits.

**Files:**
- Modify: `src/bot/utils/smart-reply.ts:37-56` (replace `smartReply`; add a helper and `smartEdit`)
- Test: `src/bot/utils/smart-reply.test.ts` (update the imports; append)

**Interfaces:**
- Consumes: `escapeHtml` from `src/utils/format.ts` (Task 1).
- Produces:
  - `smartReply(ctx: Context, message: string, options?: Parameters<Context["reply"]>[1]): Promise<void>`. The signature is unchanged; it now escapes the name under HTML.
  - `smartEdit(ctx: Context, message: string, options?: Parameters<Context["editMessageText"]>[1]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `src/bot/utils/smart-reply.test.ts`, replace the two import lines with:

```ts
import { describe, test, expect, mock } from "bun:test"
import type { Context } from "grammy"
import { personalizeMessage, smartReply, smartEdit } from "./smart-reply"
```

Append:

```ts
function fakeCtx(chatType: "private" | "group" | "supergroup", firstName: string) {
  return {
    chat: { id: 1, type: chatType },
    from: { id: 42, first_name: firstName },
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

describe("smartReply", () => {
  test("escapes the inserted name when sending HTML", async () => {
    const ctx = fakeCtx("group", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log, Tom &amp; Jerry:", { parse_mode: "HTML" })
  })

  test("inserts the name unescaped for plain text", async () => {
    const ctx = fakeCtx("group", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:")
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log, Tom & Jerry:", undefined)
  })

  test("leaves private-chat messages unchanged", async () => {
    const ctx = fakeCtx("private", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", { parse_mode: "HTML" })
  })
})

describe("smartEdit", () => {
  test("edits with the same personalization as smartReply", async () => {
    const ctx = fakeCtx("supergroup", "Maria")
    await smartEdit(ctx as unknown as Context, "✅ Logged to Fri, Sep 25:", { parse_mode: "HTML" })
    expect(ctx.editMessageText).toHaveBeenCalledWith("✅ Logged to Fri, Sep 25, Maria:", { parse_mode: "HTML" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/bot/utils/smart-reply.test.ts`
Expected: FAIL. `smartEdit` is not exported, and the HTML-escape test fails because the reply contains `Tom & Jerry` unescaped.

- [ ] **Step 3: Implement**

In `src/bot/utils/smart-reply.ts`, add below `import { Context } from "grammy"`:

```ts
import { escapeHtml } from "../../utils/format"
```

Replace the whole `smartReply` function (lines 37-56, including its doc comment) with:

```ts
/**
 * Group-chat personalization shared by smartReply and smartEdit. Under HTML
 * parse mode the name is escaped: a first name like "Tom & Jerry" would
 * otherwise make Telegram reject the message.
 */
function personalizeFor(ctx: Context, message: string, parseMode: string | undefined): string {
  const chatType = ctx.chat?.type
  const isGroupChat = chatType === "group" || chatType === "supergroup"
  if (!isGroupChat) return message

  const firstName = ctx.from?.first_name
  return personalizeMessage(
    message,
    parseMode === "HTML" && firstName ? escapeHtml(firstName) : firstName
  )
}

/**
 * Smart reply that adds name personalization in group chats.
 * In private chats, messages are sent unchanged.
 */
export async function smartReply(
  ctx: Context,
  message: string,
  options?: Parameters<Context["reply"]>[1]
): Promise<void> {
  await ctx.reply(personalizeFor(ctx, message, options?.parse_mode), options)
}

/**
 * Edits the message a button was pressed on, personalized like smartReply.
 * Without reply_markup in options, Telegram removes the inline keyboard.
 */
export async function smartEdit(
  ctx: Context,
  message: string,
  options?: Parameters<Context["editMessageText"]>[1]
): Promise<void> {
  await ctx.editMessageText(personalizeFor(ctx, message, options?.parse_mode), options)
}
```

- [ ] **Step 4: Run the tests and the type check to verify they pass**

Run: `bun test src/bot/utils/smart-reply.test.ts && bunx tsc --noEmit`
Expected: PASS, with 0 fail and the 10 existing `personalizeMessage` tests still green. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/bot/utils/smart-reply.ts src/bot/utils/smart-reply.test.ts
git commit -m "$(cat <<'EOF'
feat(bot): escape names under HTML and add smartEdit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `LogFlow` confirmation tokens and `resolveConfirmation`

This is the core of the change.
- Confirmation messages switch to the HTML summary and carry a token.
- Button presses resolve through `resolveConfirmation`, which refuses a press whose token no longer matches the stored estimate.
- The typed path and the button path share their state transitions.

**Files:**
- Modify: `src/bot/conversations/log-flow.ts`
- Test: `src/bot/conversations/log-flow.test.ts` (update the import; append inside the `describe("LogFlow")` block)

**Interfaces:**
- Consumes: `formatItemsSummary` and `shortHash` from `src/utils/format.ts` (Task 1); `formatDateForDisplay` from `src/utils/dates.ts` (existing).
- Produces:
  - `LogFlowResult` gains `parseMode?: "HTML"` and `confirm?: { token: string; totalCalories: number }`
  - `type ConfirmChoice = "log" | "change" | "cancel"`
  - `type ConfirmationOutcome = { stale: true } | { stale: false; edit: string; toast?: string; followUp?: string }`
  - `confirmToken(targetDate: string, pendingItems: string): string` (exported function)
  - `LogFlow.resolveConfirmation(telegramId: number, chatId: number, token: string, choice: ConfirmChoice): ConfirmationOutcome` (synchronous)

- [ ] **Step 1: Write the failing tests**

In `src/bot/conversations/log-flow.test.ts`, change line 4 to:

```ts
import { LogFlow, LogFlowResult, confirmToken } from "./log-flow"
```

Append inside the `describe("LogFlow", ...)` block, after the last existing test and before the closing `})`:

```ts
  async function reachConfirming(): Promise<string> {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")
    return result.confirm!.token
  }

  test("confirmation is an HTML summary with a confirm token", async () => {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")

    expect(result.parseMode).toBe("HTML")
    expect(result.message).toBe(
      "Here's what I'll log:\n<blockquote>🍗 Chicken — 200 cal</blockquote>\n<b>Total: 200 cal</b>"
    )
    const state = conversationsRepo.get(123)!
    expect(result.confirm).toEqual({
      token: confirmToken("2026-01-31", state.pending_items!),
      totalCalories: 200,
    })
  })

  test("confirmation escapes AI descriptions", async () => {
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Mac & cheese", calories: 400, emoji: "🧀" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "mac and cheese", "openai")

    expect(result.message).toContain("Mac &amp; cheese")
  })

  test("resolveConfirmation log saves the items and describes them", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "log")

    expect(outcome).toEqual({
      stale: false,
      edit: "✅ Logged to Sat, Jan 31:\n<blockquote>🍗 Chicken — 200 cal</blockquote>\n<b>Total: 200 cal</b>",
      toast: "Logged ✅",
    })
    expect(conversationsRepo.get(123)).toBeNull()
    expect(foodLogsRepo.getByDate(123, "2026-01-31")[0].items[0].calories).toBe(200)
  })

  test("resolveConfirmation change returns to input without logging", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "change")

    expect(outcome).toEqual({
      stale: false,
      edit:
        "✏️ Not logged — changing:\n<blockquote><s>🍗 Chicken — 200 cal</s></blockquote>\n" +
        "<b><s>Total: 200 cal</s></b>",
      followUp: "Okay, let's try again. What did you eat?",
    })
    expect(conversationsRepo.get(123)?.state).toBe("awaiting_input")
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
  })

  test("resolveConfirmation cancel clears the session without logging", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "cancel")

    expect(outcome).toEqual({
      stale: false,
      edit:
        "✖️ Cancelled — not logged:\n<blockquote><s>🍗 Chicken — 200 cal</s></blockquote>\n" +
        "<b><s>Total: 200 cal</s></b>",
      toast: "Cancelled",
    })
    expect(conversationsRepo.get(123)).toBeNull()
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
  })

  test("resolveConfirmation is stale with no session", () => {
    expect(logFlow.resolveConfirmation(123, 456, "abcd1234", "log")).toEqual({ stale: true })
  })

  test("resolveConfirmation is stale once the session has left confirming", async () => {
    const token = await reachConfirming()
    await logFlow.processInput(123, 456, "no", "openai")

    expect(logFlow.resolveConfirmation(123, 456, token, "log")).toEqual({ stale: true })
  })

  test("an old Log button cannot confirm a newer estimate", async () => {
    const oldToken = await reachConfirming()
    await logFlow.processInput(123, 456, "no", "openai")
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Beef", calories: 300, emoji: "🥩" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await logFlow.processInput(123, 456, "beef", "openai")

    expect(logFlow.resolveConfirmation(123, 456, oldToken, "log")).toEqual({ stale: true })
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
    expect(conversationsRepo.get(123)?.state).toBe("confirming")
  })

  test("resuming a confirming session re-sends the same token", async () => {
    const token = await reachConfirming()
    const result = await logFlow.continueOrStartOver(123, 456, "continue", "2026-02-01")

    expect(result.parseMode).toBe("HTML")
    expect(result.confirm?.token).toBe(token)
    expect(result.message).toStartWith("Continuing session for 2026-01-31.\n<blockquote>")
  })

  test("unrecognized text while confirming points to the buttons", async () => {
    await reachConfirming()
    const result = await logFlow.processInput(123, 456, "maybe", "openai")

    expect(result.message).toBe('Tap a button above, or reply "yes" / "no".')
    expect(conversationsRepo.get(123)?.state).toBe("confirming")
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/bot/conversations/log-flow.test.ts`
Expected: FAIL. `confirmToken` is not exported. Once the import resolves, the new tests fail because `parseMode`, `confirm` and `resolveConfirmation` don't exist.

- [ ] **Step 3: Implement**

In `src/bot/conversations/log-flow.ts`:

**3a.** Add below the existing imports, after line 9:

```ts
import { formatItemsSummary, shortHash } from "../../utils/format"
import { formatDateForDisplay } from "../../utils/dates"
```

**3b.** Replace the `LogFlowResult` interface (lines 11-14) with:

```ts
export interface LogFlowResult {
  message: string
  action: "prompt" | "done" | "ask_continue" | "continue" | "error"
  parseMode?: "HTML"
  /** Set on a confirmation message; the bot layer turns it into the Log/Change/Cancel keyboard. */
  confirm?: { token: string; totalCalories: number }
}

export type ConfirmChoice = "log" | "change" | "cancel"

export type ConfirmationOutcome =
  | { stale: true }
  | { stale: false; edit: string; toast?: string; followUp?: string }

/**
 * Fingerprint of a pending estimate, carried in the confirmation buttons. A
 * press only acts while the session still holds the estimate its message
 * showed. After "no" and a fresh estimate, the old message's buttons go stale
 * instead of confirming items the user never saw on that message.
 */
export function confirmToken(targetDate: string, pendingItems: string): string {
  return shortHash(`${targetDate}|${pendingItems}`)
}
```

**3c.** Replace the whole `handleConfirming` method with:

```ts
  private async handleConfirming(
    telegramId: number,
    chatId: number,
    input: string,
    state: {
      pending_items: string | null
      target_date: string
      chat_id: number
    }
  ): Promise<LogFlowResult> {
    if (input === "yes" || input === "y") {
      if (!state.pending_items) {
        return {
          message: "No items to log. Use /log to start over.",
          action: "error",
        }
      }

      const items = safeJsonParse<FoodItem[]>(state.pending_items, [])

      if (items.length === 0) {
        return {
          message:
            "Something went wrong with your saved items. Please start over with /log.",
          action: "error",
        }
      }

      this.commitPending(telegramId, chatId, state.target_date, items)

      const totalCalories = items.reduce((sum, item) => sum + item.calories, 0)
      return {
        message: `Logged ${totalCalories} calories for ${state.target_date}.`,
        action: "done",
      }
    }

    if (input === "no" || input === "n") {
      this.backToInput(telegramId, state)
      return {
        message: "Okay, let's try again. What did you eat?",
        action: "prompt",
      }
    }

    return {
      message: 'Tap a button above, or reply "yes" / "no".',
      action: "prompt",
    }
  }

  /**
   * Handles a Log / Change / Cancel button press. Stale unless the session is
   * still confirming the exact estimate the pressed message showed.
   */
  resolveConfirmation(
    telegramId: number,
    chatId: number,
    token: string,
    choice: ConfirmChoice
  ): ConfirmationOutcome {
    const state = this.conversations.get(telegramId)
    if (
      !state ||
      state.state !== "confirming" ||
      !state.pending_items ||
      confirmToken(state.target_date, state.pending_items) !== token
    ) {
      return { stale: true }
    }

    const items = safeJsonParse<FoodItem[]>(state.pending_items, [])
    if (items.length === 0) return { stale: true }

    switch (choice) {
      case "log":
        this.commitPending(telegramId, chatId, state.target_date, items)
        return {
          stale: false,
          edit: `✅ Logged to ${formatDateForDisplay(state.target_date)}:\n${formatItemsSummary(items)}`,
          toast: "Logged ✅",
        }
      case "change":
        this.backToInput(telegramId, state)
        return {
          stale: false,
          edit: `✏️ Not logged — changing:\n${formatItemsSummary(items, { struck: true })}`,
          followUp: "Okay, let's try again. What did you eat?",
        }
      case "cancel":
        this.conversations.delete(telegramId)
        return {
          stale: false,
          edit: `✖️ Cancelled — not logged:\n${formatItemsSummary(items, { struck: true })}`,
          toast: "Cancelled",
        }
    }
  }

  // State transitions shared by typed replies and button presses, so the two
  // paths cannot drift apart.

  private commitPending(
    telegramId: number,
    chatId: number,
    targetDate: string,
    items: FoodItem[]
  ): void {
    this.foodLogs.create(telegramId, chatId, targetDate, items)
    this.conversations.delete(telegramId)
  }

  private backToInput(
    telegramId: number,
    state: { chat_id: number; target_date: string }
  ): void {
    this.conversations.upsert(telegramId, state.chat_id, "awaiting_input", state.target_date)
  }

  private confirmationResult(
    header: string,
    items: FoodItem[],
    targetDate: string,
    pendingItems: string,
    action: "prompt" | "continue"
  ): LogFlowResult {
    return {
      message: `${header}\n${formatItemsSummary(items)}`,
      action,
      parseMode: "HTML",
      confirm: {
        token: confirmToken(targetDate, pendingItems),
        totalCalories: items.reduce((sum, item) => sum + item.calories, 0),
      },
    }
  }
```

**3d.** In `processEstimationResult`, replace everything from the `// We have items - move to confirming` comment down to the end of the method's final `return { ... }` with:

```ts
    // We have items - move to confirming
    const pendingItems = JSON.stringify(result.items)

    this.conversations.upsert(telegramId, chatId, "confirming", targetDate, {
      pending_items: pendingItems,
    })

    return this.confirmationResult(
      "Here's what I'll log:",
      result.items,
      targetDate,
      pendingItems,
      "prompt"
    )
```

**3e.** In `getStatusMessage`, replace the body of `case "confirming":` with:

```ts
      case "confirming":
        if (state.pending_items) {
          const items = safeJsonParse<FoodItem[]>(state.pending_items, [])
          if (items.length === 0) {
            return {
              message: "Something went wrong. Please start over with /log",
              action: "error",
            }
          }
          return this.confirmationResult(
            `Continuing session for ${state.target_date}.`,
            items,
            state.target_date,
            state.pending_items,
            "continue"
          )
        }
        return {
          message: "Something went wrong. Please start over with /log",
          action: "error",
        }
```

**3f.** Confirm that no `─` remains in the file:

Run: `grep -c "─" src/bot/conversations/log-flow.ts`
Expected: `0`

- [ ] **Step 4: Run the tests and the type check to verify they pass**

Run: `bun test src/bot/conversations/log-flow.test.ts && bunx tsc --noEmit`
Expected: PASS, with 0 fail. The 12 existing tests stay green and the 10 new tests pass. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/bot/conversations/log-flow.ts src/bot/conversations/log-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(log-flow): tokenized confirmations and resolveConfirmation

Confirmation messages become an HTML summary carrying a fingerprint of
the pending estimate. A button press only acts while the session still
holds that estimate, so an old Log button cannot confirm a newer one.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `/log` buttons and callback handler

Wire Task 4 into Telegram:
- The message handler attaches the keyboard and sends as HTML.
- A new callback handler checks the owner, resolves the press, edits in place, and handles every failure path.

**Files:**
- Create: `src/bot/utils/keyboard.ts`
- Modify: `src/bot/commands/log.ts` (imports; `createLogMessageHandler`; append new exports)
- Modify: `src/bot/index.ts` (import; `callback_query:data` dispatcher)
- Test: `src/bot/commands/log.test.ts` (new)

**Interfaces:**
- Consumes:
  - `LogFlow.resolveConfirmation`, `LogFlowResult`, `ConfirmChoice`, `ConfirmationOutcome` (Task 4)
  - `encodeLogCallback`, `parseLogCallback`, `LogAction` (Task 2)
  - `smartReply`, `smartEdit` (Task 3)
- Produces:
  - `stripKeyboard(ctx: Context): Promise<void>` in `src/bot/utils/keyboard.ts`. Task 6 uses it too.
  - `buildLogConfirmKeyboard(ownerId: number, confirm: { token: string; totalCalories: number }): InlineKeyboard`
  - `createLogCallbackHandler(logFlow: LogFlow): (ctx: Context) => Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/commands/log.test.ts`:

```ts
// src/bot/commands/log.test.ts
import { describe, test, expect, mock } from "bun:test"
import type { Context } from "grammy"
import type { LogFlow, ConfirmationOutcome } from "../conversations/log-flow"
import { buildLogConfirmKeyboard, createLogCallbackHandler } from "./log"

function fakeCallbackCtx(data: string, fromId = 42) {
  return {
    from: { id: fromId, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    editMessageReplyMarkup: mock(() => Promise.resolve(true)),
    reply: mock(() => Promise.resolve()),
  }
}

function fakeLogFlow(outcome: ConfirmationOutcome) {
  return { resolveConfirmation: mock(() => outcome) }
}

async function press(data: string, outcome: ConfirmationOutcome, fromId = 42) {
  const ctx = fakeCallbackCtx(data, fromId)
  const logFlow = fakeLogFlow(outcome)
  await createLogCallbackHandler(logFlow as unknown as LogFlow)(ctx as unknown as Context)
  return { ctx, logFlow }
}

const LOGGED: ConfirmationOutcome = { stale: false, edit: "EDIT", toast: "Logged ✅" }

describe("buildLogConfirmKeyboard", () => {
  test("puts Log full-width above Change and Cancel", () => {
    const keyboard = buildLogConfirmKeyboard(42, { token: "abcd1234", totalCalories: 335 })
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "✅ Log 335 cal", callback_data: "log:ok:42:abcd1234" }],
      [
        { text: "✏️ Change", callback_data: "log:chg:42:abcd1234" },
        { text: "✖️ Cancel", callback_data: "log:cxl:42:abcd1234" },
      ],
    ])
  })
})

describe("createLogCallbackHandler", () => {
  test("a press by someone else changes nothing", async () => {
    const { ctx, logFlow } = await press("log:ok:42:abcd1234", LOGGED, 99)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can confirm it.")
    expect(logFlow.resolveConfirmation).not.toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
  })

  test("malformed data expires the button", async () => {
    const { ctx, logFlow } = await press("log:ok:42", LOGGED)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That button has expired.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(logFlow.resolveConfirmation).not.toHaveBeenCalled()
  })

  test("a stale press strips the keyboard", async () => {
    const { ctx } = await press("log:ok:42:abcd1234", { stale: true })
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer pending.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  test("Log resolves with the owner, chat and token, then edits in place", async () => {
    const { ctx, logFlow } = await press("log:ok:42:abcd1234", LOGGED)
    expect(logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "log")
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Logged ✅")
    expect(ctx.editMessageText).toHaveBeenCalledWith("EDIT", { parse_mode: "HTML" })
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test("Change and Cancel map to their choices", async () => {
    const chg = await press("log:chg:42:abcd1234", LOGGED)
    expect(chg.logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "change")
    const cxl = await press("log:cxl:42:abcd1234", LOGGED)
    expect(cxl.logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "cancel")
  })

  test("a follow-up is sent as a new message", async () => {
    const { ctx } = await press("log:chg:42:abcd1234", {
      stale: false,
      edit: "EDIT",
      followUp: "Okay, let's try again. What did you eat?",
    })
    expect(ctx.reply).toHaveBeenCalledWith("Okay, let's try again. What did you eat?", undefined)
  })

  test("if the edit fails, the outcome is sent as a new message", async () => {
    const ctx = fakeCallbackCtx("log:ok:42:abcd1234")
    ctx.editMessageText.mockImplementation(() => Promise.reject(new Error("message to edit not found")))
    const logFlow = fakeLogFlow(LOGGED)
    await createLogCallbackHandler(logFlow as unknown as LogFlow)(ctx as unknown as Context)
    expect(ctx.reply).toHaveBeenCalledWith("EDIT", { parse_mode: "HTML" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/bot/commands/log.test.ts`
Expected: FAIL. `buildLogConfirmKeyboard` and `createLogCallbackHandler` are not exported from `./log`.

- [ ] **Step 3: Create `src/bot/utils/keyboard.ts`**

```ts
// src/bot/utils/keyboard.ts
import { Context } from "grammy"

/**
 * Removes the inline keyboard from the message a button was pressed on.
 * Best-effort: the message may already be gone or already have no keyboard.
 */
export async function stripKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup()
  } catch (error) {
    console.error("Failed to remove inline keyboard:", error)
  }
}
```

- [ ] **Step 4: Update `src/bot/commands/log.ts`**

**4a.** Replace lines 2-7 (the import block) with:

```ts
import { Context, InlineKeyboard } from "grammy"
import { LogFlow, LogFlowResult, ConfirmChoice } from "../conversations/log-flow"
import { ConversationsRepository } from "../../db/repositories/conversations"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getYesterdayInTimezone, formatDate, DEFAULT_TIMEZONE } from "../../utils/dates"
import { encodeLogCallback, parseLogCallback, LogAction } from "../utils/callback-data"
import { stripKeyboard } from "../utils/keyboard"
import { smartReply, smartEdit } from "../utils/smart-reply"
```

**4b.** In `createLogMessageHandler`, replace both occurrences of:

```ts
      await smartReply(ctx, result.message)
```

(the one inside the `continue`/`new` branch) and

```ts
    await smartReply(ctx, result.message)
```

(the final line) with the matching indentation of:

```ts
await replyWithResult(ctx, userId, result)
```

Leave `createLogCommand` unchanged. `start()` never returns a confirmation.

**4c.** Append to the end of `src/bot/commands/log.ts`:

```ts
const LOG_CHOICES: Record<LogAction, ConfirmChoice> = {
  ok: "log",
  chg: "change",
  cxl: "cancel",
}

export function buildLogConfirmKeyboard(
  ownerId: number,
  confirm: { token: string; totalCalories: number }
): InlineKeyboard {
  const data = (action: LogAction) => encodeLogCallback({ action, ownerId, token: confirm.token })
  return new InlineKeyboard()
    .text(`✅ Log ${confirm.totalCalories} cal`, data("ok"))
    .row()
    .text("✏️ Change", data("chg"))
    .text("✖️ Cancel", data("cxl"))
}

async function replyWithResult(ctx: Context, ownerId: number, result: LogFlowResult): Promise<void> {
  const options: NonNullable<Parameters<Context["reply"]>[1]> = {}
  if (result.parseMode) options.parse_mode = result.parseMode
  if (result.confirm) options.reply_markup = buildLogConfirmKeyboard(ownerId, result.confirm)
  await smartReply(ctx, result.message, options)
}

export function createLogCallbackHandler(logFlow: LogFlow) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!presserId || !chatId) {
      await ctx.answerCallbackQuery()
      return
    }

    const parsed = parseLogCallback(ctx.callbackQuery?.data ?? "")
    if (!parsed) {
      await ctx.answerCallbackQuery("That button has expired.")
      await stripKeyboard(ctx)
      return
    }

    // Owner check first, so a non-owner learns nothing about the owner's state.
    if (parsed.ownerId !== presserId) {
      await ctx.answerCallbackQuery("Only the person who started this can confirm it.")
      return
    }

    const outcome = logFlow.resolveConfirmation(presserId, chatId, parsed.token, LOG_CHOICES[parsed.action])
    if (outcome.stale) {
      await ctx.answerCallbackQuery("That entry is no longer pending.")
      await stripKeyboard(ctx)
      return
    }

    // Answer before editing so the client's spinner stops even if the edit fails.
    await ctx.answerCallbackQuery(outcome.toast)
    try {
      await smartEdit(ctx, outcome.edit, { parse_mode: "HTML" })
    } catch (error) {
      console.error("Failed to edit log confirmation:", error)
      await smartReply(ctx, outcome.edit, { parse_mode: "HTML" })
    }

    if (outcome.followUp) {
      await smartReply(ctx, outcome.followUp)
    }
  }
}
```

- [ ] **Step 5: Route `log:` presses in `src/bot/index.ts`**

Change line 16 to:

```ts
import { createLogCommand, createLogMessageHandler, createLogCallbackHandler } from "./commands/log"
```

In the `bot.on("callback_query:data", ...)` handler, add after the `pending:` branch, before `return next()`:

```ts
    if (data?.startsWith("log:")) {
      return createLogCallbackHandler(logFlow)(ctx)
    }
```

- [ ] **Step 6: Run the tests and the type check to verify they pass**

Run: `bun test src/bot/commands/log.test.ts && bun test && bunx tsc --noEmit`
Expected:
- `log.test.ts`: PASS, 8 tests.
- Full suite: 0 fail. The console shows one expected `Failed to edit log confirmation:` line from the edit-failure test.
- `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/bot/utils/keyboard.ts src/bot/commands/log.ts src/bot/commands/log.test.ts src/bot/index.ts
git commit -m "$(cat <<'EOF'
feat(log): confirm with inline buttons and edit the message in place

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/delete` confirm buttons and callback handler

Buttons go on the `/delete` confirm step only; picking stays typed. The single-delete button carries the item id and the Delete-all button carries a fingerprint of the day's item ids. Both are checked against the database, not the in-memory `deleteStates` map, so a button survives a restart.

**Files:**
- Modify: `src/db/repositories/food-logs.ts` (add `getItemForUser` after `getItemsByDate`)
- Modify: `src/db/repositories/food-logs.test.ts` (append one test)
- Modify: `src/bot/commands/delete.ts` (full replacement below)
- Modify: `src/bot/index.ts` (import; `callback_query:data` dispatcher)
- Test: `src/bot/commands/delete.test.ts` (new)

**Interfaces:**
- Consumes:
  - `shortHash` (Task 1)
  - `encodeDeleteCallback`, `parseDeleteCallback`, `DeleteCallback` (Task 2)
  - `smartReply`, `smartEdit` (Task 3)
  - `stripKeyboard` (Task 5)
- Produces:
  - `FoodLogsRepository.getItemForUser(itemId: number, telegramId: number): (FoodItem & { log_id: number }) | null`
  - `deleteAllToken(items: FoodItem[]): string`
  - `type DeleteDecision = { kind: "not_owner" } | { kind: "gone"; toast: string } | { kind: "done"; edit: string; toast: string }`
  - `resolveDeleteCallback(cb: DeleteCallback, presserId: number, foodLogsRepo: FoodLogsRepository): DeleteDecision`. It performs the database deletion and returns what to show.
  - `createDeleteCallbackHandler(foodLogsRepo: FoodLogsRepository): (ctx: Context) => Promise<void>`

- [ ] **Step 1: Write the failing repository test**

Append inside the `describe("FoodLogsRepository", ...)` block in `src/db/repositories/food-logs.test.ts`:

```ts
  test("getItemForUser returns the item only for its owner", () => {
    const log = repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const itemId = log.items[0].id!

    expect(repo.getItemForUser(itemId, 1)).toMatchObject({
      id: itemId,
      description: "Ramen",
      calories: 520,
      log_id: log.id,
    })
    expect(repo.getItemForUser(itemId, 2)).toBeNull()
    expect(repo.getItemForUser(99999, 1)).toBeNull()
  })
```

- [ ] **Step 2: Write the failing delete tests**

Create `src/bot/commands/delete.test.ts`. `food_logs.telegram_id` has a foreign key to `users`, and `createTestDb` enables foreign keys, so both users are upserted first.

```ts
// src/bot/commands/delete.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { encodeDeleteCallback } from "../utils/callback-data"
import { deleteAllToken, resolveDeleteCallback, createDeleteCallbackHandler } from "./delete"

const OWNER = 42
const OTHER = 99
const DATE = "2026-09-25"

let foodLogsRepo: FoodLogsRepository

beforeEach(() => {
  const db = createTestDb()
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(OWNER, "maria")
  usersRepo.upsert(OTHER, "bob")
  foodLogsRepo = new FoodLogsRepository(db)
})

function logItems(
  telegramId: number,
  items: { description: string; calories: number; emoji?: string }[]
) {
  return foodLogsRepo.create(telegramId, 555, DATE, items).items
}

describe("deleteAllToken", () => {
  test("does not depend on item order", () => {
    const a = { id: 2, description: "a", calories: 1 }
    const b = { id: 1, description: "b", calories: 1 }
    expect(deleteAllToken([a, b])).toBe(deleteAllToken([b, a]))
  })
})

describe("resolveDeleteCallback", () => {
  test("refuses a press by someone other than the owner", () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OTHER, foodLogsRepo)

    expect(decision).toEqual({ kind: "not_owner" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
  })

  test("deletes one item", () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "done", edit: "🗑 Deleted: 🍜 Ramen — 520 cal", toast: "Deleted" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("will not delete another user's item", () => {
    const [item] = logItems(OTHER, [{ description: "Toast", calories: 150 }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
    expect(foodLogsRepo.getItemsByDate(OTHER, DATE)).toHaveLength(1)
  })

  test("reports an item that no longer exists", () => {
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: 12345 }, OWNER, foodLogsRepo)
    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
  })

  test("deletes all of the day's items when the list is unchanged", () => {
    const items = logItems(OWNER, [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 150, emoji: "🍞" },
    ])
    const decision = resolveDeleteCallback(
      { action: "all", ownerId: OWNER, date: DATE, token: deleteAllToken(items) },
      OWNER,
      foodLogsRepo
    )

    expect(decision).toEqual({
      kind: "done",
      edit: "🗑 Deleted 2 entries (330 cal) for Fri, Sep 25.",
      toast: "Deleted",
    })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("refuses Delete all when an item was added after the prompt", () => {
    const items = logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const token = deleteAllToken(items)
    logItems(OWNER, [{ description: "Apple", calories: 95 }])

    const decision = resolveDeleteCallback({ action: "all", ownerId: OWNER, date: DATE, token }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "gone", toast: "The list changed — run /delete again." })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(2)
  })

  test("Cancel deletes nothing", () => {
    logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const decision = resolveDeleteCallback({ action: "cxl", ownerId: OWNER }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "done", edit: "✖️ Cancelled — nothing deleted.", toast: "Cancelled" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
  })
})

describe("createDeleteCallbackHandler", () => {
  function fakeCallbackCtx(data: string, fromId: number) {
    return {
      from: { id: fromId, first_name: "Maria" },
      chat: { id: 555, type: "private" },
      callbackQuery: { data },
      answerCallbackQuery: mock(() => Promise.resolve(true)),
      editMessageText: mock(() => Promise.resolve(true)),
      editMessageReplyMarkup: mock(() => Promise.resolve(true)),
      reply: mock(() => Promise.resolve()),
    }
  }

  async function press(data: string, fromId = OWNER) {
    const ctx = fakeCallbackCtx(data, fromId)
    await createDeleteCallbackHandler(foodLogsRepo)(ctx as unknown as Context)
    return ctx
  }

  test("a press by someone else is refused without touching the message", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520 }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }), OTHER)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can confirm it.")
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
  })

  test("a successful press edits the message in place", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }))

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Deleted")
    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal", undefined)
  })

  test("a stale press strips the keyboard", async () => {
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: 12345 }))

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer there.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  test("malformed data expires the button", async () => {
    const ctx = await press("del:one:42")

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That button has expired.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/db/repositories/food-logs.test.ts src/bot/commands/delete.test.ts`
Expected: FAIL. `getItemForUser` is not a function, and `deleteAllToken`, `resolveDeleteCallback` and `createDeleteCallbackHandler` are not exported.

- [ ] **Step 4: Add `getItemForUser`**

In `src/db/repositories/food-logs.ts`, add after `getItemsByDate` and before the class's closing `}`:

```ts

  getItemForUser(itemId: number, telegramId: number): (FoodItem & { log_id: number }) | null {
    const stmt = this.db.prepare(`
      SELECT fi.*, fl.id as log_id
      FROM food_items fi
      JOIN food_logs fl ON fl.id = fi.log_id
      WHERE fi.id = ? AND fl.telegram_id = ?
    `)
    return (stmt.get(itemId, telegramId) as (FoodItem & { log_id: number }) | null) ?? null
  }
```

- [ ] **Step 5: Replace `src/bot/commands/delete.ts`**

Replace the whole file with the following. The typed pick flow is unchanged apart from these changes:
- The four confirm prompts go through `promptConfirmOne` and `promptConfirmAll`, which attach the keyboard and drop the `Type "yes"…` line.
- The confirm-step re-prompt becomes `CONFIRM_FALLBACK`.
- The file gains the callback resolver and handler.

```ts
// src/bot/commands/delete.ts
import { Context, InlineKeyboard } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { shortHash } from "../../utils/format"
import { DeleteCallback, encodeDeleteCallback, parseDeleteCallback } from "../utils/callback-data"
import { stripKeyboard } from "../utils/keyboard"
import { smartReply, smartEdit } from "../utils/smart-reply"

type DeletableItem = FoodItem & { log_id: number }

interface DeleteState {
  targetDate: string
  items: DeletableItem[]
  pendingAction: "select" | "confirm_single" | "confirm_all"
  selectedItemIndex?: number
}

// Simple in-memory state for delete flow (clears on bot restart)
const deleteStates = new Map<number, DeleteState>()

const CONFIRM_FALLBACK = 'Tap a button above, or reply "yes" / "cancel".'

function formatItemLine(item: FoodItem): string {
  return `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`
}

function formatItemsList(items: DeletableItem[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item)}`).join("\n")
}

/**
 * Fingerprint of a day's items, carried in the "Delete all" button. If an item
 * is added or removed after the prompt, the press is refused rather than
 * deleting a different set than the one the user saw.
 */
export function deleteAllToken(items: FoodItem[]): string {
  const ids = items.map((item) => Number(item.id)).sort((a, b) => a - b)
  return shortHash(ids.join(","))
}

async function promptConfirmOne(ctx: Context, ownerId: number, item: DeletableItem): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("🗑 Delete", encodeDeleteCallback({ action: "one", ownerId, itemId: Number(item.id) }))
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(ctx, `Delete this entry?\n\n${formatItemLine(item)}`, { reply_markup: keyboard })
}

async function promptConfirmAll(
  ctx: Context,
  ownerId: number,
  targetDate: string,
  items: DeletableItem[]
): Promise<void> {
  const totalCalories = items.reduce((sum, item) => sum + item.calories, 0)
  const keyboard = new InlineKeyboard()
    .text(
      "🗑 Delete all",
      encodeDeleteCallback({ action: "all", ownerId, date: targetDate, token: deleteAllToken(items) })
    )
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(
    ctx,
    `Delete all ${items.length} entries for ${formatDateForDisplay(targetDate)}? (${totalCalories} cal total)`,
    { reply_markup: keyboard }
  )
}

export function createDeleteCommand(foodLogsRepo: FoodLogsRepository, usersRepo: UsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1).join(" ").trim()

    // Default to today in user's timezone
    const user = usersRepo.findById(userId)
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE
    const targetDate = getTodayInTimezone(timezone)
    const items = foodLogsRepo.getItemsByDate(userId, targetDate)

    if (items.length === 0) {
      await smartReply(ctx, `No entries for ${formatDateForDisplay(targetDate)}.`)
      return
    }

    // If arg is a number, go straight to confirm for that item
    const itemNum = parseInt(args, 10)
    if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= items.length) {
      deleteStates.set(userId, {
        targetDate,
        items,
        pendingAction: "confirm_single",
        selectedItemIndex: itemNum - 1,
      })
      await promptConfirmOne(ctx, userId, items[itemNum - 1])
      return
    }

    // If arg is "all", go to confirm all
    if (args.toLowerCase() === "all") {
      deleteStates.set(userId, {
        targetDate,
        items,
        pendingAction: "confirm_all",
      })
      await promptConfirmAll(ctx, userId, targetDate, items)
      return
    }

    // Show items and ask what to delete
    deleteStates.set(userId, {
      targetDate,
      items,
      pendingAction: "select",
    })

    await smartReply(ctx,
      `${formatDateForDisplay(targetDate)} entries:\n\n` +
        `${formatItemsList(items)}\n\n` +
        `What to delete?\n` +
        `• Enter a number to delete one item\n` +
        `• "all" to delete everything\n` +
        `• "cancel" to abort`
    )
  }
}

export function createDeleteMessageHandler(foodLogsRepo: FoodLogsRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const state = deleteStates.get(userId)
    if (!state) return

    const text = ctx.message?.text?.trim().toLowerCase()
    if (!text) return

    // Skip commands
    if (text.startsWith("/")) {
      deleteStates.delete(userId)
      return
    }

    // Handle cancel
    if (text === "cancel") {
      deleteStates.delete(userId)
      await smartReply(ctx, "Cancelled.")
      return
    }

    switch (state.pendingAction) {
      case "select": {
        // Check for number
        const itemNum = parseInt(text, 10)
        if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= state.items.length) {
          state.pendingAction = "confirm_single"
          state.selectedItemIndex = itemNum - 1
          deleteStates.set(userId, state)
          await promptConfirmOne(ctx, userId, state.items[itemNum - 1])
          return
        }

        // Check for "all"
        if (text === "all") {
          state.pendingAction = "confirm_all"
          deleteStates.set(userId, state)
          await promptConfirmAll(ctx, userId, state.targetDate, state.items)
          return
        }

        await smartReply(ctx, `Please enter a number (1-${state.items.length}), "all", or "cancel".`)
        break
      }

      case "confirm_single": {
        if (text === "yes" || text === "y") {
          const item = state.items[state.selectedItemIndex!]
          foodLogsRepo.deleteItem(item.id!)
          deleteStates.delete(userId)
          await smartReply(ctx, `Deleted: ${item.description} (${item.calories} cal)`)
          return
        }
        await smartReply(ctx, CONFIRM_FALLBACK)
        break
      }

      case "confirm_all": {
        if (text === "yes" || text === "y") {
          const count = state.items.length
          const totalCalories = state.items.reduce((sum, item) => sum + item.calories, 0)
          foodLogsRepo.deleteAllForDate(userId, state.targetDate)
          deleteStates.delete(userId)
          await smartReply(ctx, `Deleted ${count} entries (${totalCalories} cal) for ${formatDateForDisplay(state.targetDate)}.`)
          return
        }
        await smartReply(ctx, CONFIRM_FALLBACK)
        break
      }
    }
  }
}

export type DeleteDecision =
  | { kind: "not_owner" }
  | { kind: "gone"; toast: string }
  | { kind: "done"; edit: string; toast: string }

/**
 * Decides a /delete button press and performs the deletion. Everything is
 * checked against the database rather than deleteStates, so a button still
 * works after a restart and only ever deletes what its message showed.
 */
export function resolveDeleteCallback(
  cb: DeleteCallback,
  presserId: number,
  foodLogsRepo: FoodLogsRepository
): DeleteDecision {
  if (cb.ownerId !== presserId) return { kind: "not_owner" }

  switch (cb.action) {
    case "one": {
      const item = foodLogsRepo.getItemForUser(cb.itemId, presserId)
      if (!item) return { kind: "gone", toast: "That entry is no longer there." }
      foodLogsRepo.deleteItem(cb.itemId)
      return { kind: "done", edit: `🗑 Deleted: ${formatItemLine(item)}`, toast: "Deleted" }
    }
    case "all": {
      const items = foodLogsRepo.getItemsByDate(presserId, cb.date)
      if (items.length === 0 || deleteAllToken(items) !== cb.token) {
        return { kind: "gone", toast: "The list changed — run /delete again." }
      }
      const totalCalories = items.reduce((sum, item) => sum + item.calories, 0)
      foodLogsRepo.deleteAllForDate(presserId, cb.date)
      return {
        kind: "done",
        edit: `🗑 Deleted ${items.length} entries (${totalCalories} cal) for ${formatDateForDisplay(cb.date)}.`,
        toast: "Deleted",
      }
    }
    case "cxl":
      return { kind: "done", edit: "✖️ Cancelled — nothing deleted.", toast: "Cancelled" }
  }
}

export function createDeleteCallbackHandler(foodLogsRepo: FoodLogsRepository) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    if (!presserId) {
      await ctx.answerCallbackQuery()
      return
    }

    const parsed = parseDeleteCallback(ctx.callbackQuery?.data ?? "")
    if (!parsed) {
      await ctx.answerCallbackQuery("That button has expired.")
      await stripKeyboard(ctx)
      return
    }

    const decision = resolveDeleteCallback(parsed, presserId, foodLogsRepo)
    if (decision.kind === "not_owner") {
      await ctx.answerCallbackQuery("Only the person who started this can confirm it.")
      return
    }

    // The press settles this delete flow either way; drop any typed-flow state.
    clearDeleteState(presserId)
    await ctx.answerCallbackQuery(decision.toast)

    if (decision.kind === "gone") {
      await stripKeyboard(ctx)
      return
    }

    try {
      await smartEdit(ctx, decision.edit)
    } catch (error) {
      console.error("Failed to edit delete confirmation:", error)
      await smartReply(ctx, decision.edit)
    }
  }
}

export function clearDeleteState(userId: number): void {
  deleteStates.delete(userId)
}

export function hasDeleteState(userId: number): boolean {
  return deleteStates.has(userId)
}
```

- [ ] **Step 6: Route `del:` presses in `src/bot/index.ts`**

Change line 17 to:

```ts
import { createDeleteCommand, createDeleteMessageHandler, createDeleteCallbackHandler, hasDeleteState } from "./commands/delete"
```

In the `bot.on("callback_query:data", ...)` handler, add after the `log:` branch from Task 5, before `return next()`:

```ts
    if (data?.startsWith("del:")) {
      return createDeleteCallbackHandler(foodLogsRepo)(ctx)
    }
```

- [ ] **Step 7: Run the tests and the type check to verify they pass**

Run: `bun test src/db/repositories/food-logs.test.ts src/bot/commands/delete.test.ts && bun test && bunx tsc --noEmit`
Expected: PASS, with 0 fail. `tsc` prints nothing.

Also run: `grep -c 'Type "yes"' src/bot/commands/delete.ts`
Expected: `0`

- [ ] **Step 8: Commit**

```bash
git add src/db/repositories/food-logs.ts src/db/repositories/food-logs.test.ts src/bot/commands/delete.ts src/bot/commands/delete.test.ts src/bot/index.ts
git commit -m "$(cat <<'EOF'
feat(delete): confirm with inline buttons checked against the database

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Retry-job success message

This removes the last `─` rule. `formatConfirmationMessage` has no callers, so it's deleted.

**Files:**
- Modify: `src/jobs/retry-pending.ts`
- Test: `src/jobs/retry-pending.test.ts` (append)

**Interfaces:**
- Consumes: `formatItemsSummary` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/jobs/retry-pending.test.ts`:

```ts
test("announces a processed entry as an HTML summary", async () => {
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

  const job = createRetryPendingJob(
    bot as any,
    pendingRepo,
    foodLogsRepo,
    usersRepo,
    { estimate } as unknown as AIService
  )
  await job()

  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    42,
    "✅ Processed your saved entry — logged to Mon, Sep 21:\n" +
      "<blockquote>🍗 Chicken adobo — 420 cal</blockquote>\n<b>Total: 420 cal</b>",
    { parse_mode: "HTML" }
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/jobs/retry-pending.test.ts`
Expected: FAIL. `sendMessage` was called with the old `✅ Processed your saved entry!` text containing `───────────────` and no options.

- [ ] **Step 3: Implement**

In `src/jobs/retry-pending.ts`:

**3a.** Add below the `formatDateForDisplay` import (line 8):

```ts
import { formatItemsSummary } from "../utils/format"
```

**3b.** Delete the whole unused `formatConfirmationMessage` function (lines 14-31).

**3c.** Replace the notification block. It starts at the `// Notify the user` comment and runs through the closing `)` of the `bot.api.sendMessage(...)` call:

```ts
        // Notify the user
        const totalCalories = result.items.reduce((sum, item) => sum + item.calories, 0)
        const itemsDisplay = result.items
          .map((item) => `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`)
          .join("\n")

        await bot.api.sendMessage(
          entry.telegram_id,
          `✅ Processed your saved entry!\n\n` +
            `${itemsDisplay}\n` +
            `───────────────\n` +
            `Total: ${totalCalories} cal\n\n` +
            `Logged to ${formatDateForDisplay(entry.target_date)}.`
        )
```

Replace it with:

```ts
        // Notify the user
        await bot.api.sendMessage(
          entry.telegram_id,
          `✅ Processed your saved entry — logged to ${formatDateForDisplay(entry.target_date)}:\n` +
            formatItemsSummary(result.items),
          { parse_mode: "HTML" }
        )
```

- [ ] **Step 4: Run the tests and the type check to verify they pass**

Run: `bun test src/jobs/retry-pending.test.ts && bunx tsc --noEmit && grep -rc "─" src/jobs/retry-pending.ts src/bot/conversations/log-flow.ts`
Expected:
- Tests: PASS, 2 tests.
- `tsc` prints nothing.
- `grep` prints `0` for both files.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/retry-pending.ts src/jobs/retry-pending.test.ts
git commit -m "$(cat <<'EOF'
feat(retry): announce processed entries with the HTML summary

Also removes formatConfirmationMessage, which had no callers.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `README.md` (the "Logging Flow" list)
- Modify: `CHANGELOG.md` (new `[Unreleased]` section above `[0.2.0]`)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update `README.md`**

Replace the last two items of the "Logging Flow" list:

```md
4. Confirm with "yes" or retry with "no"
5. Send "cancel" at any point to exit
```

with:

```md
4. Tap **✅ Log** to save it, or **✏️ Change** to describe it again (typing "yes" / "no" also works)
5. Tap **✖️ Cancel**, or send "cancel" at any point, to exit
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Insert above the `## [0.2.0] — 2026-09-22` line:

```md
## [Unreleased]

### Changed

- **`/log` confirmation uses buttons.** `✅ Log {total} cal`, `✏️ Change` and
  `✖️ Cancel` replace typing "yes"/"no". After a tap the message is edited in
  place, so it still shows exactly what was confirmed. Typing still works.
- **`/delete` confirmation uses buttons**: `🗑 Delete` and `✖️ Cancel`. Picking
  an item is still typed.
- **Item summaries no longer draw a `─` rule**, which wrapped onto a second line
  on narrow screens. Items sit in a quote box with a bold total, and messages
  carrying one are sent with Telegram's HTML formatting.
- Confirmation buttons only act for the user they were sent to, and only on the
  estimate or items their message shows: an old Log button cannot confirm a
  newer estimate.

```

- [ ] **Step 3: Run full verification**

Run: `bun test && bunx tsc --noEmit`
Expected:
- 0 fail. The pass count rises from the 132 baseline by the tests this plan adds (54 by the plan's count), across 25 files.
- `tsc` prints nothing.

Paste the actual `bun test` summary lines into the task report. Do not paraphrase them.

- [ ] **Step 4: Confirm no stray rule or typed-confirm copy remains**

Run: `grep -rn "─\|(yes/no)\|Type \"yes\"" src --include=*.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: describe button confirmations in README and CHANGELOG

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Hand off the manual Telegram check to the human**

This step cannot be automated. Report it as outstanding and do not tick it yourself. Run it with a **separate test bot token**: polling with the production token would take updates away from the Railway deployment.

```bash
TELEGRAM_BOT_TOKEN=<test-bot-token> bun run dev
```

The tester's Telegram id must be in `ADMIN_USERS` or `allowed_users`. Checklist, from the spec:

- [ ] The quote box, bold and strikethrough render as intended. Check whether the `\n` after `</blockquote>` adds an unwanted blank line. If it does, drop that `\n` in `formatItemsSummary` and update the expected strings in Tasks 1, 4 and 7.
- [ ] Log, Change and Cancel each edit the message in place and remove the keyboard. Change also sends "Okay, let's try again. What did you eat?".
- [ ] `/delete 1`, `/delete all`, and a typed pick followed by each button.
- [ ] A group chat with two accounts:
  - A non-owner tap gets the non-owner toast.
  - After Change and a new estimate, tapping the old message's Log gets the stale toast.
  - The user's name is inserted correctly into edited messages.
- [ ] Typed "yes" / "no" / "cancel" still work at both confirm steps.

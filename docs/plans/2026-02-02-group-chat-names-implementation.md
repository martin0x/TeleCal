# Group Chat Name Mentions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add natural name personalization to bot messages in group chats (e.g., "What did you eat, Raymart?") while keeping DM behavior unchanged.

**Architecture:** A `smartReply` utility function wraps `ctx.reply()` calls. It checks `ctx.chat?.type` — in private chats, messages pass through unchanged; in group/supergroup chats, it inserts the user's first name naturally before the first line's ending punctuation.

**Tech Stack:** TypeScript, grammY (Telegram bot framework), Bun test runner

---

## Task 1: Create smartReply Utility with Tests

**Files:**
- Create: `src/bot/utils/smart-reply.ts`
- Create: `src/bot/utils/smart-reply.test.ts`

**Step 1: Write the failing tests**

Create `src/bot/utils/smart-reply.test.ts`:

```typescript
import { describe, test, expect } from "bun:test"
import { personalizeMessage } from "./smart-reply"

describe("personalizeMessage", () => {
  test("adds name before question mark", () => {
    const result = personalizeMessage("What did you eat?", "Raymart")
    expect(result).toBe("What did you eat, Raymart?")
  })

  test("adds name before period", () => {
    const result = personalizeMessage("Logged 500 calories.", "Raymart")
    expect(result).toBe("Logged 500 calories, Raymart.")
  })

  test("adds name before colon", () => {
    const result = personalizeMessage("Here's what I'll log:", "Raymart")
    expect(result).toBe("Here's what I'll log, Raymart:")
  })

  test("adds name before exclamation mark", () => {
    const result = personalizeMessage("Great choice!", "Raymart")
    expect(result).toBe("Great choice, Raymart!")
  })

  test("adds name at end when no punctuation", () => {
    const result = personalizeMessage("Cancelled", "Raymart")
    expect(result).toBe("Cancelled, Raymart")
  })

  test("only personalizes first line of multi-line message", () => {
    const input = "Here's what I'll log:\n🍕 Pizza — 300 cal"
    const result = personalizeMessage(input, "Raymart")
    expect(result).toBe("Here's what I'll log, Raymart:\n🍕 Pizza — 300 cal")
  })

  test("handles empty name by using 'friend'", () => {
    const result = personalizeMessage("What did you eat?", "")
    expect(result).toBe("What did you eat, friend?")
  })

  test("handles undefined name by using 'friend'", () => {
    const result = personalizeMessage("What did you eat?", undefined)
    expect(result).toBe("What did you eat, friend?")
  })

  test("returns empty string unchanged", () => {
    const result = personalizeMessage("", "Raymart")
    expect(result).toBe("")
  })

  test("handles first line with only whitespace", () => {
    const result = personalizeMessage("   \nActual content", "Raymart")
    expect(result).toBe("   \nActual content")
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/bot/utils/smart-reply.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/bot/utils/smart-reply.ts`:

```typescript
import { Context } from "grammy"

/**
 * Personalizes a message by inserting the user's name into the first line.
 * Inserts ", Name" before ending punctuation (? . ! :) or at end if no punctuation.
 */
export function personalizeMessage(
  message: string,
  firstName: string | undefined
): string {
  if (!message) return message

  const name = firstName?.trim() || "friend"
  const lines = message.split("\n")
  const firstLine = lines[0]

  // Skip if first line is empty or whitespace only
  if (!firstLine.trim()) return message

  // Find ending punctuation
  const punctuationMatch = firstLine.match(/([?!.:]+)\s*$/)

  let personalizedFirstLine: string
  if (punctuationMatch) {
    const punctuation = punctuationMatch[1]
    const beforePunctuation = firstLine.slice(0, punctuationMatch.index)
    personalizedFirstLine = `${beforePunctuation}, ${name}${punctuation}`
  } else {
    personalizedFirstLine = `${firstLine}, ${name}`
  }

  lines[0] = personalizedFirstLine
  return lines.join("\n")
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
  const chatType = ctx.chat?.type
  const isGroupChat = chatType === "group" || chatType === "supergroup"

  if (isGroupChat) {
    const firstName = ctx.from?.first_name
    const personalizedMessage = personalizeMessage(message, firstName)
    await ctx.reply(personalizedMessage, options)
  } else {
    await ctx.reply(message, options)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/bot/utils/smart-reply.test.ts`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add src/bot/utils/smart-reply.ts src/bot/utils/smart-reply.test.ts
git commit -m "feat: add smartReply utility for group chat name mentions"
```

---

## Task 2: Update log.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/log.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/log.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace line 86:
```typescript
// Before:
await ctx.reply(result.message)
// After:
await smartReply(ctx, result.message)
```

Replace line 123:
```typescript
// Before:
await ctx.reply(result.message)
// After:
await smartReply(ctx, result.message)
```

Replace line 128:
```typescript
// Before:
await ctx.reply(result.message)
// After:
await smartReply(ctx, result.message)
```

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS (all 61+ tests)

**Step 3: Commit**

```bash
git add src/bot/commands/log.ts
git commit -m "feat(log): use smartReply for group chat name mentions"
```

---

## Task 3: Update today.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/today.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/today.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace line 33-39 (the ctx.reply call):
```typescript
// Before:
await ctx.reply(emptyMessage, isPrivateChat ? {
// After:
await smartReply(ctx, emptyMessage, isPrivateChat ? {
```

Replace line 94-100 (the ctx.reply call):
```typescript
// Before:
await ctx.reply(message, isPrivateChat ? {
// After:
await smartReply(ctx, message, isPrivateChat ? {
```

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/today.ts
git commit -m "feat(today): use smartReply for group chat name mentions"
```

---

## Task 4: Update stats.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/stats.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/stats.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace line 67-73 (first ctx.reply in sendStatsMessage):
```typescript
// Before:
await ctx.reply(message, isPrivateChat ? {
// After:
await smartReply(ctx, message, isPrivateChat ? {
```

Replace line 131-137 (second ctx.reply in sendStatsMessage):
```typescript
// Before:
await ctx.reply(message, isPrivateChat ? {
// After:
await smartReply(ctx, message, isPrivateChat ? {
```

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/stats.ts
git commit -m "feat(stats): use smartReply for group chat name mentions"
```

---

## Task 5: Update edit.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/edit.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/edit.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace all `ctx.reply` calls with `smartReply(ctx, ...)`:
- Line 38: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 52-58: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 69-72: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 103: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 115-120: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 125: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 137-138: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 150-152: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 165-166: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 169-170: `await ctx.reply(...)` → `await smartReply(ctx, ...)`

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/edit.ts
git commit -m "feat(edit): use smartReply for group chat name mentions"
```

---

## Task 6: Update delete.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/delete.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/delete.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace all `ctx.reply` calls with `smartReply(ctx, ...)`:
- Line 38: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 54-58: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 69-72: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 83-90: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 114: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 127-131: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 140-143: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 147: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 156: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 159: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 169: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 172: `await ctx.reply(...)` → `await smartReply(ctx, ...)`

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/delete.ts
git commit -m "feat(delete): use smartReply for group chat name mentions"
```

---

## Task 7: Update settings.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/settings.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/settings.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace all `ctx.reply` calls with `smartReply(ctx, ...)`:
- Line 63: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 67-69: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 195: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 201: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 207: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 215: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 221: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 227: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 233-236: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 242: `await ctx.reply(...)` → `await smartReply(ctx, ...)`

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/settings.ts
git commit -m "feat(settings): use smartReply for group chat name mentions"
```

---

## Task 8: Update pending.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/pending.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/pending.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace all `ctx.reply` calls with `smartReply(ctx, ...)`:
- Line 33: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 43-46: `await ctx.reply(...)` → `await smartReply(ctx, ...)`

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/pending.ts
git commit -m "feat(pending): use smartReply for group chat name mentions"
```

---

## Task 9: Update admin.ts to use smartReply

**Files:**
- Modify: `src/bot/commands/admin.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/commands/admin.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace all `ctx.reply` calls with `smartReply(ctx, ...)`:
- Line 10: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 19-24: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 32: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 36: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 45: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 49: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 53: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 58: `await ctx.reply(...)` → `await smartReply(ctx, ...)`
- Line 63: `await ctx.reply(...)` → `await smartReply(ctx, ...)`

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/admin.ts
git commit -m "feat(admin): use smartReply for group chat name mentions"
```

---

## Task 10: Update allowlist.ts middleware to use smartReply

**Files:**
- Modify: `src/bot/middleware/allowlist.ts`

**Step 1: Update imports and replace ctx.reply calls**

In `src/bot/middleware/allowlist.ts`, add import at top:

```typescript
import { smartReply } from "../utils/smart-reply"
```

Replace line 19:
```typescript
// Before:
await ctx.reply("⛔ Sorry, this bot is invite-only.\nContact the admin to request access.")
// After:
await smartReply(ctx, "⛔ Sorry, this bot is invite-only.\nContact the admin to request access.")
```

**Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/middleware/allowlist.ts
git commit -m "feat(allowlist): use smartReply for group chat name mentions"
```

---

## Task 11: Final verification and cleanup

**Step 1: Run all tests**

Run: `bun test`
Expected: PASS (all tests including new smart-reply tests)

**Step 2: Verify no ctx.reply calls remain in command files**

Run: `grep -r "ctx\.reply" src/bot/commands/ src/bot/middleware/`
Expected: No matches (or only in callback handlers using `ctx.answerCallbackQuery`)

Note: `ctx.editMessageText` and `ctx.answerCallbackQuery` are intentionally NOT changed — they're for inline keyboard updates, not new messages.

**Step 3: Test manually (optional)**

Start bot in dev mode and test in a group chat:
- `/log` should say "What did you eat, YourName?"
- `/today` should personalize the first line
- DMs should remain unchanged

**Step 4: Commit any final fixes if needed**

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | smart-reply.ts, smart-reply.test.ts | Create utility with tests |
| 2 | log.ts | Update /log command |
| 3 | today.ts | Update /today command |
| 4 | stats.ts | Update /week, /month commands |
| 5 | edit.ts | Update /edit command |
| 6 | delete.ts | Update /delete command |
| 7 | settings.ts | Update /settings command |
| 8 | pending.ts | Update /pending command |
| 9 | admin.ts | Update /admin command |
| 10 | allowlist.ts | Update access denied message |
| 11 | — | Final verification |

**Total estimated changes:** ~50 lines new code, ~30 line replacements across 9 files

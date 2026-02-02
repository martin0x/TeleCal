# Group Chat Name Mentions Design

**Date:** 2026-02-02
**Status:** Approved

## Overview

Add natural name mentions in group chat messages to make it clear who the bot is addressing. Messages like "What did you eat?" become "What did you eat, Raymart?" in group contexts, while DMs remain unchanged.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Implementation approach | Reply wrapper utility (`smartReply`) |
| Which messages | All messages in group chats |
| Name placement | First line only, before punctuation |

## The `smartReply` Utility

**Location:** `src/bot/utils/smart-reply.ts`

**Core Function:**
```typescript
smartReply(ctx: Context, message: string): Promise<void>
```

**Behavior:**
- Detects chat type via `ctx.chat?.type`
- In private chats (`"private"`): replies with the message unchanged
- In group chats (`"group"` or `"supergroup"`): personalizes the first line with the user's name from `ctx.from?.first_name`

**Name Insertion Logic:**
- Finds the first line (everything before the first `\n` or the whole message if single-line)
- Inserts `, {Name}` before the ending punctuation (`?`, `!`, `.`, `:`)
- If no punctuation, appends `, {Name}` to the end of the first line
- Falls back to "friend" if `first_name` is somehow unavailable

**Examples:**

| Original | Group Chat Output |
|----------|-------------------|
| `What did you eat?` | `What did you eat, Raymart?` |
| `Logged 500 calories.` | `Logged 500 calories, Raymart.` |
| `Here's what I'll log:\n🍕 Pizza` | `Here's what I'll log, Raymart:\n🍕 Pizza` |

## Integration Points

**Files to Update:**

| File | Commands/Handlers |
|------|-------------------|
| `src/bot/commands/log.ts` | `/log` command, message handler |
| `src/bot/commands/today.ts` | `/today` command |
| `src/bot/commands/edit.ts` | `/edit` command |
| `src/bot/commands/delete.ts` | `/delete` command |
| `src/bot/commands/stats.ts` | `/stats`, `/week`, `/month` commands |
| `src/bot/commands/settings.ts` | `/settings` command |
| `src/bot/commands/pending.ts` | `/pending` command |
| `src/bot/commands/admin.ts` | `/admin` command |
| `src/bot/middleware/allowlist.ts` | Access denied messages |

**What Stays Unchanged:**
- The `LogFlow` class — it continues returning plain messages
- Message content/logic — only the delivery mechanism changes
- DM behavior — completely unchanged

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No `first_name` available | Falls back to `"friend"` |
| Empty message | Returns without replying |
| Message with only whitespace first line | Skips personalization, replies as-is |
| First line ends with emoji | Appends `, Name` after emoji |
| First line has no punctuation | Appends `, Name` at end |

## Testing Strategy

New test file: `src/bot/utils/smart-reply.test.ts`

Test cases:
1. Private chat returns message unchanged
2. Group chat adds name to single-line message
3. Group chat adds name to first line of multi-line message
4. Handles missing `first_name` gracefully
5. Correctly inserts before `?`, `!`, `.`, `:`
6. Handles messages with no punctuation
7. Supergroup behaves same as group

## File Structure

**New Files:**
```
src/bot/utils/
├── smart-reply.ts       # smartReply utility function
└── smart-reply.test.ts  # Unit tests
```

**Modified Files (9 total):**
- `src/bot/commands/log.ts`
- `src/bot/commands/today.ts`
- `src/bot/commands/edit.ts`
- `src/bot/commands/delete.ts`
- `src/bot/commands/stats.ts`
- `src/bot/commands/settings.ts`
- `src/bot/commands/pending.ts`
- `src/bot/commands/admin.ts`
- `src/bot/middleware/allowlist.ts`

## Out of Scope

- Customizable name format per user
- Mention with `@username` instead of first name
- Configuring which message types get personalized

# Chat UI: Width-Free Summaries and Button Confirmations — Design

**Date:** 2026-09-25
**Status:** Approved for planning
**Related:** [#3 — Improve chat UI](https://github.com/martin0x/TeleCal/issues/3),
[#9 — /settings and /pending buttons act on whoever presses them](https://github.com/martin0x/TeleCal/issues/9),
[#2 — Simplify the conversation state machinery](https://github.com/martin0x/TeleCal/issues/2)

## Problem

Two weaknesses in the bot's chat UI, both described in #3:

1. **Width-dependent separators.** Item summaries draw a rule of 15–17 `─` characters.
   No character count is right on every device; on a narrow screen or at a large font
   size the rule wraps onto a second line.
2. **Typed confirmations.** `/log` and `/delete` ask the user to type "yes". In a group
   chat a typed "yes" is loose, and a button press is both faster and unambiguous about
   who pressed it.

## Goals

1. No message depends on the client's width.
2. `/log` confirmation and `/delete` confirmation are done with inline buttons.
3. A button can only ever act on the exact estimate or item its message shows, and only
   for the user it was sent to.
4. Typed replies keep working as a fallback.

## Non-goals

- Buttons on the `/log` "continue or new?" prompt. It stays typed.
- Buttons on the `/delete` pick step. The user picks by typing a number or "all".
- Owner checks on the existing `/settings` and `/pending` keyboards — that is #9.
- The Mini App.

## User-facing behavior

### Item summary format

Every item summary uses a quote box with a bold total beneath it. This replaces the
`─` rule everywhere it appears.

```html
Here's what I'll log:
<blockquote>🍳 2 scrambled eggs — 180 cal
🍞 Toast with butter — 150 cal
☕ Black coffee — 5 cal</blockquote>
<b>Total: 335 cal</b>
```

Messages containing a summary are sent with `parse_mode: "HTML"`. Every interpolated
string in them is escaped (`&`, `<`, `>`).

**Constraint:** the first line of an HTML message carries no markup. `smartReply`
inserts the user's name into the first line in group chats and does not parse tags.

### `/log` confirmation

Sent on a new estimate, and again when a user resumes a session that is in
`confirming`. The "Log this? (yes/no)" line is removed.

| Row | Button | Callback data |
|---|---|---|
| 1 (full width) | `✅ Log {total} cal` | `log:ok:{ownerId}:{token}` |
| 2 | `✏️ Change` | `log:chg:{ownerId}:{token}` |
| 2 | `✖️ Cancel` | `log:cxl:{ownerId}:{token}` |

After a valid press the same message is edited in place, and the keyboard is removed:

| Button | Edited message | Toast | Follow-up message |
|---|---|---|---|
| Log | `✅ Logged to {Fri, Sep 25}:` + summary | `Logged ✅` | — |
| Change | `✏️ Not logged — changing:` + summary, items and total struck through | — | `Okay, let's try again. What did you eat?` |
| Cancel | `✖️ Cancelled — not logged:` + summary, items and total struck through | `Cancelled` | — |

The date uses `formatDateForDisplay`. The follow-up is a new message because the
conversation continues and the next reply belongs at the bottom of the chat.

**Typed fallback.** "yes"/"y", "no"/"n" and "cancel" keep working in `confirming` and
keep their current short replies, sent as new messages. Unrecognized text in
`confirming` now gets `Tap a button above, or reply "yes" / "no".`

### `/delete` confirmation

The pick step is unchanged: the user types a number or "all". Every confirm prompt gets
buttons — after a typed pick, and when `/delete 3` or `/delete all` go straight to the
confirm step. The `Type "yes" to confirm or "cancel" to abort.` line is removed.

`/delete` messages stay plain text. They have no summary block, so they need no HTML.

| Prompt | Buttons and callback data |
|---|---|
| Single item | `🗑 Delete` → `del:one:{ownerId}:{itemId}` · `✖️ Cancel` → `del:cxl:{ownerId}` |
| All | `🗑 Delete all` → `del:all:{ownerId}:{date}:{token}` · `✖️ Cancel` → `del:cxl:{ownerId}` |

After a valid press, the message is edited and the keyboard removed:

| Press | Edited message | Toast |
|---|---|---|
| Delete one | `🗑 Deleted: {emoji} {description} — {calories} cal` | `Deleted` |
| Delete all | `🗑 Deleted {n} entries ({total} cal) for {Fri, Sep 25}.` | `Deleted` |
| Cancel | `✖️ Cancelled — nothing deleted.` | `Cancelled` |

**Typed fallback.** "yes"/"y" and "cancel" keep working. Unrecognized text at a confirm
step gets `Tap a button above, or reply "yes" / "cancel".`

### Background retry success

`retry-pending.ts` sends:

```html
✅ Processed your saved entry — logged to Fri, Sep 25:
<blockquote>…</blockquote>
<b>Total: 335 cal</b>
```

with `parse_mode: "HTML"`. The retry job logs automatically and asks nothing, so it gets
no buttons.

### When a button cannot act

The press is answered with a toast, and the stale keyboard is removed from the message.

| Case | Toast | Keyboard removed? |
|---|---|---|
| Presser is not `ownerId` | `Only the person who started this can confirm it.` | No — it still belongs to the owner |
| `/log`: no session, session not in `confirming`, or token mismatch | `That entry is no longer pending.` | Yes |
| `/delete` one: item missing or not the presser's | `That entry is no longer there.` | Yes |
| `/delete` all: today's item ids no longer match the token | `The list changed — run /delete again.` | Yes |
| Malformed `log:` / `del:` data | `That button has expired.` | Yes |

The owner check runs first, so a non-owner learns nothing about the owner's state.

## Architecture

### Shared formatting — `src/utils/format.ts`

- `escapeHtml(text: string): string` — escapes `&`, `<`, `>`.
- `formatItemsSummary(items, opts?: { struck?: boolean }): string` — the quote box and
  bold total. Escapes descriptions; defaults a missing emoji to `🍽️`. With `struck`, the
  item lines and the total are wrapped in `<s>`.
- `shortHash(text: string): string` — first 8 hex characters of SHA-256 (`node:crypto`).

This replaces the four copies of the item-line mapping in `log-flow.ts` and
`retry-pending.ts`. `/delete` and `/edit` keep their own numbered `formatItemsList`.

### Callback data — `src/bot/utils/callback-data.ts`

Encode and parse functions for the `log:` and `del:` formats above. Parsing is pure and
returns `null` for anything malformed. The worst case, `del:all:` with a 16-digit id,
is 44 bytes, inside Telegram's 64-byte limit.

### `smart-reply.ts`

- `smartReply` escapes the first name when `options.parse_mode === "HTML"`.
- New `smartEdit(ctx, message, options?)` — the same personalization, then
  `ctx.editMessageText`. Called without `reply_markup`, it removes the keyboard.

### `LogFlow` — `src/bot/conversations/log-flow.ts`

`LogFlow` stays free of grammY types, so it stays testable with plain data.

- `LogFlowResult` gains `parseMode?: "HTML"` and
  `confirm?: { token: string; totalCalories: number }`. `confirm` is set on confirmation
  messages; the bot layer turns it into the keyboard.
- The token is `shortHash(target_date + pending_items)`, computed from the stored
  `conversation_state` row whenever it is needed. It is never stored, so no schema change.
- New `resolveConfirmation(telegramId, token, choice: "log" | "change" | "cancel")`
  returns `{ stale: true }`, or `{ edit, toast?, followUp? }`.
- The typed `yes` / `no` path and the button path share one private state transition, so
  they cannot drift apart. Only the reply copy differs by path.

### Bot layer

- `src/bot/commands/log.ts`:
  - The message handler attaches the keyboard when `result.confirm` is set, and passes
    `result.parseMode` through to `smartReply`.
  - New `createLogCallbackHandler(logFlow)`: parse, owner check, `resolveConfirmation`,
    `smartEdit`, `answerCallbackQuery`, then the follow-up via `smartReply`.
- `src/bot/commands/delete.ts`:
  - Confirm prompts carry the keyboard.
  - New pure `resolveDeleteCallback(parsed, presserId, foodLogsRepo)` makes the decision.
  - New `createDeleteCallbackHandler(foodLogsRepo)` acts on that decision and calls
    `clearDeleteState(ownerId)`.
  - The handler checks against the database, not the in-memory `deleteStates` map, so a
    button still works after a restart.
- `FoodLogsRepository.getItemForUser(itemId, telegramId)` — new. Returns the item only if
  it belongs to that user.
- `src/bot/index.ts` — the `callback_query:data` dispatcher routes the `log:` and `del:`
  prefixes.

### `src/jobs/retry-pending.ts`

Uses `formatItemsSummary` and sends with `parse_mode: "HTML"`. `formatConfirmationMessage`
is deleted — it has no callers.

## Error handling

- **Edit fails** (message deleted, "message is not modified", or the message is too old):
  the error is caught. If the action itself succeeded, the outcome is sent as a new
  message instead.
- **`answerCallbackQuery` runs on every path**, including failures, so the client's
  loading spinner never hangs.
- **Stripping a stale keyboard** is best-effort; an error there is logged and ignored.
- **Double tap:** grammY processes updates one at a time and SQLite writes are
  synchronous. The first tap clears the session, so the second tap is stale.

## Testing

Unit tests with `bun test`:

- `src/utils/format.test.ts`:
  - `escapeHtml` handles `&`, `<`, `>`.
  - `formatItemsSummary` escapes descriptions, e.g. `mac & cheese` → `mac &amp; cheese`.
  - The default 🍽️ emoji, and the struck variant.
  - `shortHash` is deterministic and returns 8 hex characters.
- `src/bot/utils/callback-data.test.ts`:
  - Round trip for every format.
  - Malformed input returns `null`.
  - Every encoded value is at most 64 bytes with a 16-digit id.
- `src/bot/conversations/log-flow.test.ts`:
  - Confirmation results carry `confirm` and `parseMode`.
  - `resolveConfirmation` for log, change and cancel.
  - No session → stale.
  - A resumed session produces the same token.
  - Typed "yes" and "no" still work.
  - **Regression:** "no" → a new estimate → press the old token → stale, and nothing is
    logged.
- `src/bot/commands/delete.test.ts` (new) — `resolveDeleteCallback`:
  - Wrong owner.
  - Missing item.
  - Another user's item.
  - The list changed since the prompt.
  - Success for one item and for all.
- `src/db/repositories/food-logs.test.ts` — `getItemForUser` returns `null` for another
  user's item.
- `src/bot/utils/smart-reply.test.ts` — the name is escaped under HTML and unchanged
  otherwise.
- `src/jobs/retry-pending.test.ts` — the success message is sent as HTML with a
  blockquote.

Manual check in Telegram, using a **separate test bot token**. Polling with the
production token would take updates away from the Railway deployment.

- [ ] The quote box, bold and strikethrough render as intended. Check whether the `\n`
      after `</blockquote>` adds an unwanted blank line, and adjust `formatItemsSummary`
      if it does.
- [ ] Log, Change and Cancel each edit the message in place and remove the keyboard.
- [ ] `/delete 1`, `/delete all`, and a typed pick followed by each button.
- [ ] A group chat with two accounts: the non-owner toast; the stale toast after Change
      and a new estimate; the name insertion on edited messages.
- [ ] Typed "yes" / "no" / "cancel" still work at both confirm steps.

## Decisions

Recorded so they are not re-litigated.

| Decision | Rejected alternatives | Why |
|---|---|---|
| Quote box with bold total | Blank line only; short `┈┈┈` token; bold total alone | Most visually distinct region with no width dependency. Cost: HTML parse mode and escaping. |
| Full-width `✅ Log {total} cal`, then Change / Cancel | Two buttons; three in one row | The common action is the biggest target and restates what is being committed. Cancel is needed or an unwanted session lingers until the next `/log`. |
| Edit the message in place and keep the items | Edit to the outcome only; strip buttons and reply below | One message per log that still records exactly what was confirmed. |
| `/delete`: buttons on the confirm step only | Number-grid picker; one button per item; no buttons | A picker means too many buttons on a busy day. The confirm step is where the destructive action and the group-chat ambiguity sit. |
| Content fingerprint in callback data | Store the prompt's `message_id` in a new column; `updated_at` as the token | No schema change — `schema.sql` has no mechanism for adding a column to an existing table. The fingerprint describes what the message shows, so it survives restarts. |
| `/delete` buttons carry the item id and are checked against the DB | Rely on the in-memory `deleteStates` | The id binds the button exactly to the item it shows, and it works after a restart. |
| Owner id in callback data | Trust the presser | In a group, anyone can press any keyboard. Existing keyboards are fixed in #9. |
| Keep the typed fallback | Buttons only | Costs nothing, and covers any client where a keyboard fails to render. |
| `/delete` messages stay plain text | HTML for consistency | No summary block there, so HTML would add escaping for no visual gain. |

## Known limitations

**Old buttons stay visible after a typed confirmation.** The prompt's `message_id` is not
stored, so a typed "yes" cannot remove the keyboard. Pressing it later shows the stale
toast.

**Identical re-estimates share a token.** If a user re-estimates and gets byte-identical
items for the same date, the old message's buttons still work. That is harmless: they
act on identical items.

**`/delete` Cancel does not repeat the item.** The cancel callback carries no item id, so
the edited message reads `✖️ Cancelled — nothing deleted.`

**#2 should account for the new entry point.** `resolveConfirmation` is a second way into
the `confirming` state, next to typed input.

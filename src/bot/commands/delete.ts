// src/bot/commands/delete.ts
import { Context, InlineKeyboard } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { shortHash, formatItemLine, formatTotals, sumTotals } from "../../utils/format"
import { DeleteCallback, encodeDeleteCallback, parseDeleteCallback } from "../utils/callback-data"
import { stripKeyboard, answerCallback } from "../utils/keyboard"
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
  const keyboard = new InlineKeyboard()
    .text(
      "🗑 Delete all",
      encodeDeleteCallback({ action: "all", ownerId, date: targetDate, token: deleteAllToken(items) })
    )
    .text("✖️ Cancel", encodeDeleteCallback({ action: "cxl", ownerId }))
  await smartReply(
    ctx,
    `Delete all ${items.length} entries for ${formatDateForDisplay(targetDate)}? (${formatTotals(sumTotals(items))} total)`,
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
          await smartReply(ctx, `Deleted: ${formatItemLine(item)}`)
          return
        }
        await smartReply(ctx, CONFIRM_FALLBACK)
        break
      }

      case "confirm_all": {
        if (text === "yes" || text === "y") {
          const count = state.items.length
          foodLogsRepo.deleteAllForDate(userId, state.targetDate)
          deleteStates.delete(userId)
          await smartReply(ctx, `Deleted ${count} entries (${formatTotals(sumTotals(state.items))}) for ${formatDateForDisplay(state.targetDate)}.`)
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
      foodLogsRepo.deleteAllForDate(presserId, cb.date)
      return {
        kind: "done",
        edit: `🗑 Deleted ${items.length} entries (${formatTotals(sumTotals(items))}) for ${formatDateForDisplay(cb.date)}.`,
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
      await answerCallback(ctx)
      return
    }

    const parsed = parseDeleteCallback(ctx.callbackQuery?.data ?? "")
    if (!parsed) {
      await answerCallback(ctx, "That button has expired.")
      await stripKeyboard(ctx)
      return
    }

    const decision = resolveDeleteCallback(parsed, presserId, foodLogsRepo)
    if (decision.kind === "not_owner") {
      await answerCallback(ctx, "Only the person who started this can confirm it.")
      return
    }

    await answerCallback(ctx, decision.toast)

    if (decision.kind === "gone") {
      await stripKeyboard(ctx)
      return
    }

    // The press resolved this delete flow; drop any typed-flow state.
    clearDeleteState(presserId)

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

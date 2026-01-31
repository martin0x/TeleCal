// src/bot/commands/delete.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { getToday, formatDateForDisplay } from "../../utils/dates"

interface DeleteState {
  targetDate: string
  items: (FoodItem & { log_id: number })[]
  pendingAction: "select" | "confirm_single" | "confirm_all"
  selectedItemIndex?: number
}

// Simple in-memory state for delete flow (clears on bot restart)
const deleteStates = new Map<number, DeleteState>()

function formatItemsList(items: (FoodItem & { log_id: number })[]): string {
  return items
    .map((item, i) => `${i + 1}. ${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`)
    .join("\n")
}

export function createDeleteCommand(foodLogsRepo: FoodLogsRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1).join(" ").trim()

    // Default to today
    const targetDate = getToday()
    const items = foodLogsRepo.getItemsByDate(userId, targetDate)

    if (items.length === 0) {
      await ctx.reply(`No entries for ${formatDateForDisplay(targetDate)}.`)
      return
    }

    const totalCalories = items.reduce((sum, item) => sum + item.calories, 0)

    // If arg is a number, go straight to confirm for that item
    const itemNum = parseInt(args, 10)
    if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= items.length) {
      const item = items[itemNum - 1]
      deleteStates.set(userId, {
        targetDate,
        items,
        pendingAction: "confirm_single",
        selectedItemIndex: itemNum - 1,
      })
      await ctx.reply(
        `Delete this entry?\n\n` +
          `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal\n\n` +
          `Type "yes" to confirm or "cancel" to abort.`
      )
      return
    }

    // If arg is "all", go to confirm all
    if (args.toLowerCase() === "all") {
      deleteStates.set(userId, {
        targetDate,
        items,
        pendingAction: "confirm_all",
      })
      await ctx.reply(
        `Delete all ${items.length} entries for ${formatDateForDisplay(targetDate)}? (${totalCalories} cal total)\n\n` +
          `Type "yes" to confirm or "cancel" to abort.`
      )
      return
    }

    // Show items and ask what to delete
    deleteStates.set(userId, {
      targetDate,
      items,
      pendingAction: "select",
    })

    await ctx.reply(
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
      await ctx.reply("Cancelled.")
      return
    }

    switch (state.pendingAction) {
      case "select": {
        // Check for number
        const itemNum = parseInt(text, 10)
        if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= state.items.length) {
          const item = state.items[itemNum - 1]
          state.pendingAction = "confirm_single"
          state.selectedItemIndex = itemNum - 1
          deleteStates.set(userId, state)
          await ctx.reply(
            `Delete this entry?\n\n` +
              `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal\n\n` +
              `Type "yes" to confirm or "cancel" to abort.`
          )
          return
        }

        // Check for "all"
        if (text === "all") {
          const totalCalories = state.items.reduce((sum, item) => sum + item.calories, 0)
          state.pendingAction = "confirm_all"
          deleteStates.set(userId, state)
          await ctx.reply(
            `Delete all ${state.items.length} entries for ${formatDateForDisplay(state.targetDate)}? (${totalCalories} cal total)\n\n` +
              `Type "yes" to confirm or "cancel" to abort.`
          )
          return
        }

        await ctx.reply(`Please enter a number (1-${state.items.length}), "all", or "cancel".`)
        break
      }

      case "confirm_single": {
        if (text === "yes" || text === "y") {
          const item = state.items[state.selectedItemIndex!]
          foodLogsRepo.deleteItem(item.id!)
          deleteStates.delete(userId)
          await ctx.reply(`Deleted: ${item.description} (${item.calories} cal)`)
          return
        }
        await ctx.reply(`Type "yes" to confirm or "cancel" to abort.`)
        break
      }

      case "confirm_all": {
        if (text === "yes" || text === "y") {
          const count = state.items.length
          const totalCalories = state.items.reduce((sum, item) => sum + item.calories, 0)
          foodLogsRepo.deleteAllForDate(userId, state.targetDate)
          deleteStates.delete(userId)
          await ctx.reply(`Deleted ${count} entries (${totalCalories} cal) for ${formatDateForDisplay(state.targetDate)}.`)
          return
        }
        await ctx.reply(`Type "yes" to confirm or "cancel" to abort.`)
        break
      }
    }
  }
}

export function clearDeleteState(userId: number): void {
  deleteStates.delete(userId)
}

export function hasDeleteState(userId: number): boolean {
  return deleteStates.has(userId)
}

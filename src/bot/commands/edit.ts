// src/bot/commands/edit.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"

interface EditState {
  targetDate: string
  items: (FoodItem & { log_id: number })[]
  pendingAction: "select" | "edit"
  selectedItemIndex?: number
}

// Simple in-memory state for edit flow
const editStates = new Map<number, EditState>()

function formatItemsList(items: (FoodItem & { log_id: number })[]): string {
  return items
    .map((item, i) => `${i + 1}. ${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`)
    .join("\n")
}

export function createEditCommand(foodLogsRepo: FoodLogsRepository, usersRepo: UsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1).join(" ").trim()

    const user = usersRepo.findById(userId)
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE
    const targetDate = getTodayInTimezone(timezone)
    const items = foodLogsRepo.getItemsByDate(userId, targetDate)

    if (items.length === 0) {
      await ctx.reply(`No entries for ${formatDateForDisplay(targetDate)}.`)
      return
    }

    // If arg is a number, go straight to edit that item
    const itemNum = parseInt(args, 10)
    if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= items.length) {
      const item = items[itemNum - 1]
      editStates.set(userId, {
        targetDate,
        items,
        pendingAction: "edit",
        selectedItemIndex: itemNum - 1,
      })
      await ctx.reply(
        `Editing: ${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal\n\n` +
          `What would you like to change?\n` +
          `• Type a number to set calories manually\n` +
          `• Type new description to re-estimate\n` +
          `• "cancel" to abort`
      )
      return
    }

    // Show items and ask which to edit
    editStates.set(userId, {
      targetDate,
      items,
      pendingAction: "select",
    })

    await ctx.reply(
      `${formatDateForDisplay(targetDate)} entries:\n\n` +
        `${formatItemsList(items)}\n\n` +
        `Which item to edit? (enter number or "cancel")`
    )
  }
}

export function createEditMessageHandler(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository,
  aiService: AIService
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const state = editStates.get(userId)
    if (!state) return

    const text = ctx.message?.text?.trim()
    if (!text) return

    // Skip commands
    if (text.startsWith("/")) {
      editStates.delete(userId)
      return
    }

    const lower = text.toLowerCase()

    // Handle cancel
    if (lower === "cancel") {
      editStates.delete(userId)
      await ctx.reply("Cancelled.")
      return
    }

    switch (state.pendingAction) {
      case "select": {
        const itemNum = parseInt(text, 10)
        if (!isNaN(itemNum) && itemNum >= 1 && itemNum <= state.items.length) {
          const item = state.items[itemNum - 1]
          state.pendingAction = "edit"
          state.selectedItemIndex = itemNum - 1
          editStates.set(userId, state)
          await ctx.reply(
            `Editing: ${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal\n\n` +
              `What would you like to change?\n` +
              `• Type a number to set calories manually\n` +
              `• Type new description to re-estimate\n` +
              `• "cancel" to abort`
          )
          return
        }

        await ctx.reply(`Please enter a number (1-${state.items.length}) or "cancel".`)
        break
      }

      case "edit": {
        const item = state.items[state.selectedItemIndex!]

        // Check if input is a number (calorie update)
        const newCalories = parseInt(text, 10)
        if (!isNaN(newCalories) && newCalories > 0 && newCalories < 10000) {
          foodLogsRepo.updateItem(item.id!, { calories: newCalories })
          editStates.delete(userId)
          await ctx.reply(
            `Updated: ${item.emoji ?? "🍽️"} ${item.description} — ${newCalories} cal`
          )
          return
        }

        // Otherwise, it's a new description - re-estimate with AI
        try {
          const user = usersRepo.findById(userId)
          const provider = user?.ai_provider ?? "openai"
          const result = await aiService.estimate(text, provider)

          if (result.needsClarification || result.items.length === 0) {
            await ctx.reply(
              `Couldn't estimate calories for "${text}".\n` +
                `Try typing a number instead, or "cancel" to abort.`
            )
            return
          }

          // Use the first item's calories
          const newItem = result.items[0]
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            emoji: newItem.emoji,
          })
          editStates.delete(userId)
          await ctx.reply(
            `Updated: ${newItem.emoji ?? "🍽️"} ${newItem.description} — ${newItem.calories} cal`
          )
        } catch (error) {
          await ctx.reply(
            `Couldn't reach AI to estimate. Try typing a number instead, or "cancel" to abort.`
          )
        }
        break
      }
    }
  }
}

export function clearEditState(userId: number): void {
  editStates.delete(userId)
}

export function hasEditState(userId: number): boolean {
  return editStates.has(userId)
}

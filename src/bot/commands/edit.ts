// src/bot/commands/edit.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { smartReply } from "../utils/smart-reply"
import { formatItemLine } from "../../utils/format"

interface EditState {
  targetDate: string
  items: (FoodItem & { log_id: number })[]
  pendingAction: "select" | "edit"
  selectedItemIndex?: number
}

// Simple in-memory state for edit flow
const editStates = new Map<number, EditState>()

function formatItemsList(items: (FoodItem & { log_id: number })[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item)}`).join("\n")
}

function editPrompt(item: FoodItem): string {
  return (
    `Editing: ${formatItemLine(item)}\n\n` +
    `What would you like to change?\n` +
    `• Type a number to set calories (e.g. 200 or 200 cal)\n` +
    `• Type a number with g to set protein (e.g. 18g)\n` +
    `• Or describe the food to re-estimate\n` +
    `• Type "cancel" to abort`
  )
}

export type EditInput =
  | { kind: "calories"; value: number }
  | { kind: "protein"; value: number }
  | { kind: "invalid"; message: string }
  | { kind: "describe"; text: string }

/** "200" → calories, "18g" → protein, anything else → re-estimate. */
export function parseEditInput(text: string): EditInput {
  const protein = text.match(/^\s*(\d+)\s*g\s*$/i)
  if (protein) {
    const value = parseInt(protein[1], 10)
    if (value < 0 || value > 1000) return { kind: "invalid", message: "Protein must be between 0 and 1000 g." }
    return { kind: "protein", value }
  }

  const calories = text.match(/^\s*(\d+)\s*(?:k?cal(?:ories)?)?\s*$/i)
  if (calories) {
    const value = parseInt(calories[1], 10)
    if (value < 1 || value > 9999) return { kind: "invalid", message: "Calories must be between 1 and 9999." }
    return { kind: "calories", value }
  }

  return { kind: "describe", text: text.trim() }
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
      await smartReply(ctx, `No entries for ${formatDateForDisplay(targetDate)}.`)
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
      await smartReply(ctx, editPrompt(item))
      return
    }

    // Show items and ask which to edit
    editStates.set(userId, {
      targetDate,
      items,
      pendingAction: "select",
    })

    await smartReply(ctx,
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
      await smartReply(ctx, "Cancelled.")
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
          await smartReply(ctx, editPrompt(item))
          return
        }

        await smartReply(ctx, `Please enter a number (1-${state.items.length}) or "cancel".`)
        break
      }

      case "edit": {
        const item = state.items[state.selectedItemIndex!]
        const input = parseEditInput(text)

        if (input.kind === "invalid") {
          await smartReply(ctx, input.message)
          return
        }

        if (input.kind === "calories") {
          foodLogsRepo.updateItem(item.id!, { calories: input.value })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, calories: input.value })}`)
          return
        }

        if (input.kind === "protein") {
          foodLogsRepo.updateItem(item.id!, { protein_g: input.value })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, protein_g: input.value })}`)
          return
        }

        // A description: re-estimate with AI and replace every field.
        try {
          const user = usersRepo.findById(userId)
          const provider = user?.ai_provider ?? "openai"
          const result = await aiService.estimate(input.text, provider, {
            telegramId: userId,
            chatId: ctx.chat?.id ?? null,
            callType: "edit",
          })

          if (result.needsClarification || result.items.length === 0) {
            await smartReply(ctx,
              `Couldn't estimate "${input.text}".\n` +
                `Try a number (calories) or a number with g (protein) instead, or "cancel" to abort.`
            )
            return
          }

          const newItem = result.items[0]
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            protein_g: newItem.protein_g,
            emoji: newItem.emoji,
          })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine(newItem)}`)
        } catch (error) {
          await smartReply(ctx,
            `Couldn't reach AI to estimate. Try a number instead, or "cancel" to abort.`
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

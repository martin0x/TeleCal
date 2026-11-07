// src/bot/commands/edit.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { smartReply } from "../utils/smart-reply"
import { formatItemLine } from "../../utils/format"
import {
  MACROS,
  MAX_GRAMS,
  DEFAULT_MACROS,
  getMacro,
  macroByKeyword,
  macroValuesOf,
  withMacro,
  type MacroKey,
  type MacroValues,
} from "../../macros"

interface EditState {
  targetDate: string
  items: (FoodItem & { log_id: number })[]
  pendingAction: "select" | "edit"
  selectedItemIndex?: number
}

// Simple in-memory state for edit flow
const editStates = new Map<number, EditState>()

function formatItemsList(items: (FoodItem & { log_id: number })[], macros: readonly MacroKey[]): string {
  return items.map((item, i) => `${i + 1}. ${formatItemLine(item, macros)}`).join("\n")
}

function editPrompt(item: FoodItem, macros: readonly MacroKey[]): string {
  const hints = ["• Type a number to set calories (e.g. 200 or 200 cal)"]
  if (macros.includes("protein")) hints.push("• Type a number with g to set protein (e.g. 18g)")
  const extra = MACROS.find((m) => m.key !== "protein" && macros.includes(m.key))
  if (extra) hints.push(`• Add the macro's name to set another (e.g. 5g ${extra.keywords[0]})`)
  hints.push("• Or describe the food to re-estimate", '• Type "cancel" to abort')
  return `Editing: ${formatItemLine(item, macros)}\n\nWhat would you like to change?\n${hints.join("\n")}`
}

export type EditInput =
  | { kind: "calories"; value: number }
  | { kind: "macro"; key: MacroKey; value: number }
  | { kind: "invalid"; message: string }
  | { kind: "describe"; text: string }

/** Every macro's /edit words, longest first, a space matching any run of whitespace. */
const MACRO_WORDS = MACROS.flatMap((m) => [...m.keywords])
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/ /g, "\\s+"))
  .join("|")
/** "18g" or "18 g" (protein), or "3g sugar": grams, then optionally a macro's word. */
const MACRO_INPUT = new RegExp(`^\\s*(\\d+)\\s*g(?:\\s+(${MACRO_WORDS}))?\\s*$`, "i")

/** "200" → calories, "18g" → protein, "3g sugar" → that macro, anything else → re-estimate. */
export function parseEditInput(text: string): EditInput {
  const grams = text.match(MACRO_INPUT)
  if (grams) {
    const macro = grams[2] ? macroByKeyword(grams[2])! : getMacro("protein")
    const value = parseInt(grams[1], 10)
    if (value > MAX_GRAMS) return { kind: "invalid", message: `${macro.name} must be between 0 and ${MAX_GRAMS} g.` }
    return { kind: "macro", key: macro.key, value }
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
    const macros = user?.tracked_macros ?? DEFAULT_MACROS
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
      await smartReply(ctx, editPrompt(item, macros))
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
        `${formatItemsList(items, macros)}\n\n` +
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

    const macros = usersRepo.findById(userId)?.tracked_macros ?? DEFAULT_MACROS

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
          await smartReply(ctx, editPrompt(item, macros))
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
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, calories: input.value }, macros)}`)
          return
        }

        if (input.kind === "macro") {
          const update: Partial<MacroValues> = { [getMacro(input.key).column]: input.value }
          foodLogsRepo.updateItem(item.id!, update)
          editStates.delete(userId)
          // The edited macro shows even if the user doesn't track it, so they see it took.
          await smartReply(ctx, `Updated: ${formatItemLine({ ...item, ...update }, withMacro(macros, input.key))}`)
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
              `Couldn't estimate "${input.text}".\n\n` +
                `Try a number (calories) or a number with g (protein) instead, or "cancel" to abort.`
            )
            return
          }

          const newItem = result.items[0]
          foodLogsRepo.updateItem(item.id!, {
            description: newItem.description,
            calories: newItem.calories,
            ...macroValuesOf(newItem),
            emoji: newItem.emoji,
          })
          editStates.delete(userId)
          await smartReply(ctx, `Updated: ${formatItemLine(newItem, macros)}`)
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

// src/bot/conversations/log-flow.ts
import {
  ConversationsRepository,
  ConversationStateType,
} from "../../db/repositories/conversations"
import { FoodLogsRepository, FoodItem } from "../../db/repositories/food-logs"
import { PendingRepository } from "../../db/repositories/pending"
import { AIService } from "../../ai/service"
import { EstimationResult } from "../../ai/types"
import { formatItemsSummary, shortHash } from "../../utils/format"
import { formatDateForDisplay } from "../../utils/dates"

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

interface ConversationContext {
  originalInput?: string
  clarificationHistory?: string[]
}

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database data or encoding issues.
 */
function safeJsonParse<T>(json: string | null, defaultValue: T): T {
  if (!json) return defaultValue
  try {
    return JSON.parse(json) as T
  } catch (error) {
    console.error(
      "JSON parse error:",
      error,
      "Input preview:",
      json?.substring(0, 100)
    )
    return defaultValue
  }
}

export class LogFlow {
  constructor(
    private conversations: ConversationsRepository,
    private foodLogs: FoodLogsRepository,
    private pending: PendingRepository,
    private aiService: AIService
  ) {}

  async start(
    telegramId: number,
    chatId: number,
    targetDate: string,
    provider: string
  ): Promise<LogFlowResult> {
    const existing = this.conversations.get(telegramId)

    if (existing) {
      return {
        message:
          `You already have an active log session for ${existing.target_date}.\n\n` +
          `Reply "continue" to resume it, or "new" to start fresh for ${targetDate}.`,
        action: "ask_continue",
      }
    }

    this.conversations.upsert(telegramId, chatId, "awaiting_input", targetDate)

    return {
      message: "What did you eat?",
      action: "prompt",
    }
  }

  async continueOrStartOver(
    telegramId: number,
    chatId: number,
    choice: "continue" | "new",
    targetDate: string
  ): Promise<LogFlowResult> {
    if (choice === "continue") {
      const existing = this.conversations.get(telegramId)
      if (existing) {
        return this.getStatusMessage(existing)
      }
    }

    // Start fresh
    this.conversations.delete(telegramId)
    this.conversations.upsert(telegramId, chatId, "awaiting_input", targetDate)

    return {
      message: "What did you eat?",
      action: "prompt",
    }
  }

  async processInput(
    telegramId: number,
    chatId: number,
    input: string,
    provider: string
  ): Promise<LogFlowResult> {
    const state = this.conversations.get(telegramId)

    if (!state) {
      return {
        message: "No active log session. Use /log to start one.",
        action: "error",
      }
    }

    const trimmedInput = input.trim().toLowerCase()

    // Handle cancel at any point
    if (trimmedInput === "cancel") {
      this.conversations.delete(telegramId)
      return {
        message: "Cancelled. Use /log when you're ready to log food.",
        action: "done",
      }
    }

    switch (state.state) {
      case "awaiting_input":
        return this.handleAwaitingInput(telegramId, chatId, input, provider, state.target_date)

      case "clarifying":
        return this.handleClarifying(telegramId, chatId, input, provider, state)

      case "confirming":
        return this.handleConfirming(telegramId, chatId, trimmedInput, state)

      default:
        return {
          message: "Something went wrong. Use /log to start over.",
          action: "error",
        }
    }
  }

  private async handleAwaitingInput(
    telegramId: number,
    chatId: number,
    input: string,
    provider: string,
    targetDate: string
  ): Promise<LogFlowResult> {
    try {
      const result = await this.aiService.estimate(input, provider, {
        telegramId,
        chatId,
        callType: "estimate",
      })
      return this.processEstimationResult(telegramId, chatId, input, result, targetDate)
    } catch (error) {
      return this.handleAIError(telegramId, chatId, input, targetDate)
    }
  }

  private async handleClarifying(
    telegramId: number,
    chatId: number,
    input: string,
    provider: string,
    state: {
      pending_food: string | null
      context: string | null
      target_date: string
    }
  ): Promise<LogFlowResult> {
    // Build context from previous conversation
    const context = safeJsonParse<ConversationContext>(state.context, {})
    const contextStr = this.buildContextString(state.pending_food, context)

    try {
      const result = await this.aiService.estimate(input, provider, {
        telegramId,
        chatId,
        callType: "clarify",
        context: contextStr,
      })
      return this.processEstimationResult(telegramId, chatId, input, result, state.target_date, context)
    } catch (error) {
      return this.handleAIError(telegramId, chatId, `${state.pending_food} - ${input}`, state.target_date)
    }
  }

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

  private processEstimationResult(
    telegramId: number,
    chatId: number,
    input: string,
    result: EstimationResult,
    targetDate: string,
    previousContext?: ConversationContext
  ): LogFlowResult {
    if (result.needsClarification) {
      const context: ConversationContext = {
        originalInput: previousContext?.originalInput ?? input,
        clarificationHistory: [
          ...(previousContext?.clarificationHistory ?? []),
          input,
        ],
      }

      this.conversations.upsert(telegramId, chatId, "clarifying", targetDate, {
        pending_food: input,
        context: JSON.stringify(context),
      })

      return {
        message: result.clarificationQuestion ?? "Could you provide more details?",
        action: "prompt",
      }
    }

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
  }

  private handleAIError(
    telegramId: number,
    chatId: number,
    input: string,
    targetDate: string
  ): LogFlowResult {
    // Save to pending entries
    this.pending.create(telegramId, chatId, input, targetDate)
    this.conversations.delete(telegramId)

    return {
      message:
        "Couldn't reach the AI right now. I've saved your entry — " +
        "I'll estimate and notify you when it's ready.\n\n" +
        "You can check pending entries with /pending",
      action: "done",
    }
  }

  private buildContextString(
    pendingFood: string | null,
    context: ConversationContext
  ): string {
    const parts: string[] = []

    if (context.originalInput) {
      parts.push(`Original input: "${context.originalInput}"`)
    }

    if (pendingFood && pendingFood !== context.originalInput) {
      parts.push(`Most recent input: "${pendingFood}"`)
    }

    if (context.clarificationHistory && context.clarificationHistory.length > 0) {
      parts.push(`Previous clarifications: ${context.clarificationHistory.join(", ")}`)
    }

    return parts.join(". ")
  }

  private getStatusMessage(state: {
    state: ConversationStateType
    pending_food: string | null
    pending_items: string | null
    target_date: string
  }): LogFlowResult {
    switch (state.state) {
      case "awaiting_input":
        return {
          message: `Continuing session for ${state.target_date}. What did you eat?`,
          action: "continue",
        }
      case "clarifying":
        return {
          message:
            `Continuing session for ${state.target_date}.\n` +
            `You mentioned: "${state.pending_food}"\n\n` +
            `Could you provide more details?`,
          action: "continue",
        }
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
      default:
        return {
          message: "Something went wrong. Please start over with /log",
          action: "error",
        }
    }
  }
}

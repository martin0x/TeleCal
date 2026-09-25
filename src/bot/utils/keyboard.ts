// src/bot/utils/keyboard.ts
import { Context, GrammyError } from "grammy"

/**
 * Removes the inline keyboard from the message a button was pressed on.
 * Best-effort: the message may already be gone or already have no keyboard.
 */
export async function stripKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup()
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) return
    console.error("Failed to remove inline keyboard:", error)
  }
}

/**
 * Answers the pressed button's callback query. Best-effort: Telegram rejects
 * answers to queries that are too old, and by then the action has already
 * happened — failing here must not abort the rest of the handler.
 */
export async function answerCallback(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text)
  } catch (error) {
    console.error("Failed to answer callback query:", error)
  }
}

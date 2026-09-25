// src/bot/utils/keyboard.ts
import { Context } from "grammy"

/**
 * Removes the inline keyboard from the message a button was pressed on.
 * Best-effort: the message may already be gone or already have no keyboard.
 */
export async function stripKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup()
  } catch (error) {
    console.error("Failed to remove inline keyboard:", error)
  }
}

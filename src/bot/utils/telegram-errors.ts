// src/bot/utils/telegram-errors.ts
import { GrammyError } from "grammy"

/**
 * Telegram failures that are part of normal operation (a user blocked the bot,
 * a message was re-edited to the same text). They stay as log lines and are
 * not reported to error tracking, where they would only be noise.
 */
export function isExpectedTelegramError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  if (error.error_code === 403) return true
  return error.error_code === 400 && /chat not found|message is not modified/.test(error.description)
}

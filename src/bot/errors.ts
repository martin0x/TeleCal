// src/bot/errors.ts
import type { BotError, Context } from "grammy"
import type { Analytics } from "../analytics"
import { isExpectedTelegramError } from "./utils/telegram-errors"

/** bot.catch handler. Without one, grammY stops polling on the first uncaught error. */
export function createBotErrorHandler(analytics: Analytics) {
  return (err: BotError<Context>) => {
    const update = err.ctx.update
    console.error(`Error while handling update ${update.update_id}:`, err.error)
    if (isExpectedTelegramError(err.error)) return
    const updateType = Object.keys(update).find((key) => key !== "update_id")
    analytics.captureException(err.error, err.ctx.from?.id, {
      source: "bot",
      update_id: update.update_id,
      update_type: updateType,
    })
  }
}

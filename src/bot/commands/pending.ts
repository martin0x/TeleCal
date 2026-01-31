// src/bot/commands/pending.ts
import { Context, InlineKeyboard } from "grammy"
import { PendingRepository } from "../../db/repositories/pending"
import { formatDateForDisplay } from "../../utils/dates"

function formatPendingEntry(entry: {
  food_text: string
  submitted_at: string
  target_date: string
}, index: number): string {
  const submitted = new Date(entry.submitted_at + "Z")
  const submittedStr = submitted.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    `${index + 1}. "${entry.food_text}"\n` +
    `   Submitted: ${submittedStr} → will log to ${formatDateForDisplay(entry.target_date)}`
  )
}

export function createPendingCommand(pendingRepo: PendingRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const entries = pendingRepo.getByUser(userId)

    if (entries.length === 0) {
      await ctx.reply("No pending entries. All caught up!")
      return
    }

    const entriesText = entries.map((e, i) => formatPendingEntry(e, i)).join("\n\n")

    const keyboard = new InlineKeyboard()
      .text("Cancel All", "pending:cancel_all")
      .text("Retry Now", "pending:retry")

    await ctx.reply(
      `📋 Pending entries:\n\n${entriesText}`,
      { reply_markup: keyboard }
    )
  }
}

export function createPendingCallbackHandler(pendingRepo: PendingRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const data = ctx.callbackQuery?.data
    if (!data?.startsWith("pending:")) return

    const action = data.replace("pending:", "")

    switch (action) {
      case "cancel_all": {
        const count = pendingRepo.deleteAllForUser(userId)
        await ctx.editMessageText(`Cancelled ${count} pending ${count === 1 ? "entry" : "entries"}.`)
        await ctx.answerCallbackQuery("Pending entries cancelled")
        break
      }

      case "retry": {
        // For now, just acknowledge - the retry job will pick them up
        // In a future enhancement, we could trigger immediate retry
        await ctx.answerCallbackQuery("Entries will be retried soon")
        break
      }
    }
  }
}

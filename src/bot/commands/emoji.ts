// src/bot/commands/emoji.ts
import { Context } from "grammy"
import { GroupBadgesRepository } from "../../db/repositories/group-badges"
import { smartReply, type GroupBadgeFlavor } from "../utils/smart-reply"

const RESET_WORDS = new Set(["reset", "default", "clear", "off"])
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * The input as a badge if it is exactly one emoji: a pictograph (skin tones
 * and ZWJ sequences included), a flag, or a keycap like 1️⃣. Bare digits and
 * symbols that only have an emoji variant are refused.
 */
export function parseBadgeEmoji(input: string): string | null {
  const text = input.trim()
  const segments = [...graphemes.segment(text)]
  if (segments.length !== 1) return null
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|⃣/u.test(text) ? text : null
}

const USAGE = "Send one emoji, like /emoji 🦊, or /emoji reset for the default."

export function createEmojiCommand(groupBadgesRepo: GroupBadgesRepository) {
  return async (ctx: Context & GroupBadgeFlavor) => {
    const userId = ctx.from?.id
    const chat = ctx.chat
    if (!userId || !chat) return

    if (chat.type !== "group" && chat.type !== "supergroup") {
      await smartReply(ctx, "Badges are per group. Send /emoji 🦊 in a group to pick yours there.")
      return
    }

    const arg = (ctx.message?.text ?? "").replace(/^\/\S+\s*/, "").trim()

    if (!arg) {
      const current = ctx.groupBadge
        ? `Your badge in this group is ${ctx.groupBadge}.`
        : "You have the default badge in this group."
      await smartReply(ctx, `${current}\n\n${USAGE}`)
      return
    }

    if (RESET_WORDS.has(arg.toLowerCase())) {
      groupBadgesRepo.clear(chat.id, userId)
      ctx.groupBadge = null
      await smartReply(ctx, "Back to the default badge in this group.")
      return
    }

    const emoji = parseBadgeEmoji(arg)
    if (!emoji) {
      await smartReply(ctx, USAGE)
      return
    }

    if (!groupBadgesRepo.set(chat.id, userId, emoji)) {
      await smartReply(ctx, `${emoji} is already another member's badge in this group. Pick a different one.`)
      return
    }

    // The confirmation itself goes out under the new badge.
    ctx.groupBadge = emoji
    await smartReply(ctx, `Your badge in this group is now ${emoji}.`)
  }
}

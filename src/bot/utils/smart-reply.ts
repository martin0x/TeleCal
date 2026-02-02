// src/bot/utils/smart-reply.ts
import { Context } from "grammy"

/**
 * Personalizes a message by inserting the user's name into the first line.
 * Inserts ", Name" before ending punctuation (? . ! :) or at end if no punctuation.
 */
export function personalizeMessage(
  message: string,
  firstName: string | undefined
): string {
  if (!message) return message

  const name = firstName?.trim() || "friend"
  const lines = message.split("\n")
  const firstLine = lines[0]

  // Skip if first line is empty or whitespace only
  if (!firstLine.trim()) return message

  // Find ending punctuation
  const punctuationMatch = firstLine.match(/([?!.:]+)\s*$/)

  let personalizedFirstLine: string
  if (punctuationMatch) {
    const punctuation = punctuationMatch[1]
    const beforePunctuation = firstLine.slice(0, punctuationMatch.index)
    personalizedFirstLine = `${beforePunctuation}, ${name}${punctuation}`
  } else {
    personalizedFirstLine = `${firstLine}, ${name}`
  }

  lines[0] = personalizedFirstLine
  return lines.join("\n")
}

/**
 * Smart reply that adds name personalization in group chats.
 * In private chats, messages are sent unchanged.
 */
export async function smartReply(
  ctx: Context,
  message: string,
  options?: Parameters<Context["reply"]>[1]
): Promise<void> {
  const chatType = ctx.chat?.type
  const isGroupChat = chatType === "group" || chatType === "supergroup"

  if (isGroupChat) {
    const firstName = ctx.from?.first_name
    const personalizedMessage = personalizeMessage(message, firstName)
    await ctx.reply(personalizedMessage, options)
  } else {
    await ctx.reply(message, options)
  }
}

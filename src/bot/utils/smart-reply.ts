// src/bot/utils/smart-reply.ts
import { Context } from "grammy"
import { escapeHtml } from "../../utils/format"

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
 * Group-chat personalization shared by smartReply and smartEdit. Under HTML
 * parse mode the name is escaped: a first name like "Tom & Jerry" would
 * otherwise make Telegram reject the message.
 */
function personalizeFor(ctx: Context, message: string, parseMode: string | undefined): string {
  const chatType = ctx.chat?.type
  const isGroupChat = chatType === "group" || chatType === "supergroup"
  if (!isGroupChat) return message

  const firstName = ctx.from?.first_name
  return personalizeMessage(
    message,
    parseMode === "HTML" && firstName ? escapeHtml(firstName) : firstName
  )
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
  await ctx.reply(personalizeFor(ctx, message, options?.parse_mode), options)
}

/**
 * Edits the message a button was pressed on, personalized like smartReply.
 * Without reply_markup in options, Telegram removes the inline keyboard.
 */
export async function smartEdit(
  ctx: Context,
  message: string,
  options?: Parameters<Context["editMessageText"]>[1]
): Promise<void> {
  await ctx.editMessageText(personalizeFor(ctx, message, options?.parse_mode), options)
}

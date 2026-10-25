// src/bot/utils/smart-reply.ts
import { Context } from "grammy"
import { escapeHtml } from "../../utils/format"

function isGroupChat(ctx: Context): boolean {
  const chatType = ctx.chat?.type
  return chatType === "group" || chatType === "supergroup"
}

/**
 * The user's message a group reply should quote: the one being answered, or
 * after a button press, the one the button's message answered, provided the
 * presser wrote it. Undefined when there is none.
 */
function ownMessageId(ctx: Context): number | undefined {
  if (ctx.message) return ctx.message.message_id
  const original = ctx.callbackQuery?.message?.reply_to_message
  if (original && original.from?.id === ctx.from?.id) return original.message_id
  return undefined
}

/**
 * The fallback for a group reply that can't quote the user: their name in
 * bold on its own first line. The name needs HTML, so a plain-text message
 * is escaped and sent as HTML; the text the user sees is unchanged.
 */
function withNameHeader<O extends { parse_mode?: string }>(
  ctx: Context,
  message: string,
  options: O | undefined
): { text: string; options: O } {
  const name = ctx.from?.first_name?.trim() || "friend"
  const body = options?.parse_mode === "HTML" ? message : escapeHtml(message)
  return {
    text: `<b>${escapeHtml(name)}</b>\n${body}`,
    options: { ...options, parse_mode: "HTML" } as O,
  }
}

/**
 * Reply that, in group chats, quotes the user's message it answers, so each
 * reply shows whose it is. With nothing to quote it starts with the user's
 * name instead. Private-chat messages are sent unchanged.
 */
export async function smartReply(
  ctx: Context,
  message: string,
  options?: Parameters<Context["reply"]>[1]
): Promise<void> {
  if (!isGroupChat(ctx) || options?.reply_parameters) {
    await ctx.reply(message, options)
    return
  }

  const quoted = ownMessageId(ctx)
  if (quoted === undefined) {
    const named = withNameHeader(ctx, message, options)
    await ctx.reply(named.text, named.options)
    return
  }

  await ctx.reply(message, {
    ...options,
    reply_parameters: { message_id: quoted, allow_sending_without_reply: true },
  })
}

/**
 * Edits the message a button was pressed on. An edit keeps the message's
 * quote, so in a group it only adds the name when the message has none.
 * Without reply_markup in options, Telegram removes the inline keyboard.
 */
export async function smartEdit(
  ctx: Context,
  message: string,
  options?: Parameters<Context["editMessageText"]>[1]
): Promise<void> {
  if (!isGroupChat(ctx) || ctx.callbackQuery?.message?.reply_to_message) {
    await ctx.editMessageText(message, options)
    return
  }

  const named = withNameHeader(ctx, message, options)
  await ctx.editMessageText(named.text, named.options)
}

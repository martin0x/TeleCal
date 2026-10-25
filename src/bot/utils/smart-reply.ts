// src/bot/utils/smart-reply.ts
import { Context } from "grammy"
import { escapeHtml } from "../../utils/format"

/**
 * The emoji a member picked with /emoji for the current group, set on the
 * context by middleware in createBot. Unset or null: the default badge.
 */
export interface GroupBadgeFlavor {
  groupBadge?: string | null
}

// The default badge, one per user, so a glance down a busy group tells whose
// replies are whose. The name beside it settles the rare clash.
const BADGES = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚪"]

export function userBadge(userId: number): string {
  return BADGES[Math.abs(userId) % BADGES.length]
}

/** The HTML first line of every group-chat reply: "🔵 <b>Maria</b>". */
export function groupHeader(userId: number, firstName: string | undefined, badge?: string | null): string {
  const name = firstName?.trim() || "friend"
  return `${badge || userBadge(userId)} <b>${escapeHtml(name)}</b>`
}

function isGroupChat(ctx: Context): boolean {
  const chatType = ctx.chat?.type
  return chatType === "group" || chatType === "supergroup"
}

/**
 * Group-chat labelling shared by smartReply and smartEdit. The header needs
 * HTML, so a plain-text message is escaped and sent as HTML; the text the
 * user sees is unchanged.
 */
function labelFor<O extends { parse_mode?: string }>(
  ctx: Context,
  message: string,
  options: O | undefined
): { text: string; options: O | undefined } {
  if (!isGroupChat(ctx) || !ctx.from) return { text: message, options }

  const body = options?.parse_mode === "HTML" ? message : escapeHtml(message)
  return {
    text: `${groupHeader(ctx.from.id, ctx.from.first_name, (ctx as Context & GroupBadgeFlavor).groupBadge)}\n${body}`,
    options: { ...options, parse_mode: "HTML" } as O,
  }
}

/**
 * Reply that, in group chats, starts with the user's badge and name and
 * quotes the message it answers. Private-chat messages are sent unchanged.
 */
export async function smartReply(
  ctx: Context,
  message: string,
  options?: Parameters<Context["reply"]>[1]
): Promise<void> {
  const labelled = labelFor(ctx, message, options)
  let sendOptions = labelled.options
  // Only a user's own message is quoted; after a button press there is none.
  if (isGroupChat(ctx) && ctx.message && !sendOptions?.reply_parameters) {
    sendOptions = {
      ...sendOptions,
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    }
  }
  await ctx.reply(labelled.text, sendOptions)
}

/**
 * Edits the message a button was pressed on, labelled like smartReply.
 * Without reply_markup in options, Telegram removes the inline keyboard.
 */
export async function smartEdit(
  ctx: Context,
  message: string,
  options?: Parameters<Context["editMessageText"]>[1]
): Promise<void> {
  const labelled = labelFor(ctx, message, options)
  await ctx.editMessageText(labelled.text, labelled.options)
}

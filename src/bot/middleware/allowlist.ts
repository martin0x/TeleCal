// src/bot/middleware/allowlist.ts
import { Context, NextFunction } from "grammy"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import {
  ALREADY_PENDING,
  GROUP_INVITE_PROMPT,
  INVITE_ONLY,
  INVITE_PROMPT,
  NOT_APPROVED,
  REQUEST_PENDING,
  REQUEST_SENT,
  parseAccessRequest,
  privateRequestKeyboard,
  requestAccessKeyboard,
  sourceFromStart,
  type AccessSource,
  type NotifyAdmins,
} from "../access"
import { noopAnalytics, type Analytics } from "../../analytics"
import { smartEdit, smartReply } from "../utils/smart-reply"

export interface AllowlistDeps {
  allowedUsersRepo: AllowedUsersRepository
  accessRequestsRepo: AccessRequestsRepository
  adminIds: number[]
  notifyAdmins: NotifyAdmins
  analytics?: Analytics
}

/**
 * Admins and allowlisted users continue down the chain. Everyone else is
 * handled entirely here and never reaches the rest of the bot (so no users
 * row is created for them): they get the invite prompt, and its button
 * files an access request.
 */
export function createAllowlistMiddleware(deps: AllowlistDeps) {
  const { allowedUsersRepo, accessRequestsRepo, adminIds, notifyAdmins } = deps
  const analytics = deps.analytics ?? noopAnalytics

  async function handleRequest(ctx: Context, userId: number, source: AccessSource): Promise<void> {
    const result = accessRequestsRepo.request(userId, ctx.from?.username, ctx.from?.first_name)
    if (result === "already_pending") {
      await ctx.answerCallbackQuery({ text: ALREADY_PENDING })
      return
    }
    if (result === "declined") {
      await ctx.answerCallbackQuery({ text: NOT_APPROVED })
      return
    }
    analytics.capture(userId, "access_requested", { source })
    try {
      await ctx.answerCallbackQuery()
      await smartEdit(ctx, REQUEST_SENT)
    } catch (error) {
      // The request is already committed; admins must still hear about it
      // even if we couldn't confirm it back to the user.
      console.error("[access] could not confirm the request to the user:", error)
    }
    await notifyAdmins(accessRequestsRepo.find(userId)!)
  }

  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (adminIds.includes(userId) || allowedUsersRepo.isAllowed(userId)) {
      return next()
    }

    if (ctx.callbackQuery) {
      const request = parseAccessRequest(ctx.callbackQuery.data)
      if (request) {
        return handleRequest(ctx, userId, request.source)
      }
      await ctx.answerCallbackQuery({ text: INVITE_ONLY })
      return
    }

    // Drops my_chat_member, edited_message, channel posts, etc. — anything
    // that isn't a chat message has no text to reply to and nowhere sane to
    // reply into.
    if (!ctx.message) return

    if (ctx.chat?.type !== "private") {
      // Only reply to commands, and only with a DM link: a group reply's
      // "Request access" button would file the request from the group, and
      // the eventual approval DM would 403 if the stranger never opened a
      // private chat with the bot. No access request is created from here.
      if (ctx.message.text?.startsWith("/")) {
        await smartReply(ctx, GROUP_INVITE_PROMPT, { reply_markup: privateRequestKeyboard(ctx.me.username) })
      }
      return
    }

    const existing = accessRequestsRepo.find(userId)
    if (existing?.status === "pending") {
      await smartReply(ctx, REQUEST_PENDING)
      return
    }
    if (existing?.status === "declined") {
      await smartReply(ctx, NOT_APPROVED)
      return
    }
    await smartReply(ctx, INVITE_PROMPT, { reply_markup: requestAccessKeyboard(sourceFromStart(ctx.message.text)) })
  }
}

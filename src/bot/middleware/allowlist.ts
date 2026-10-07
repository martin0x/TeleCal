// src/bot/middleware/allowlist.ts
import { Context, NextFunction } from "grammy"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import {
  ACCESS_REQUEST_DATA,
  ALREADY_PENDING,
  INVITE_ONLY,
  INVITE_PROMPT,
  NOT_APPROVED,
  REQUEST_PENDING,
  REQUEST_SENT,
  requestAccessKeyboard,
  type NotifyAdmins,
} from "../access"
import { smartEdit, smartReply } from "../utils/smart-reply"

export interface AllowlistDeps {
  allowedUsersRepo: AllowedUsersRepository
  accessRequestsRepo: AccessRequestsRepository
  adminIds: number[]
  notifyAdmins: NotifyAdmins
}

/**
 * Admins and allowlisted users continue down the chain. Everyone else is
 * handled entirely here and never reaches the rest of the bot (so no users
 * row is created for them): they get the invite prompt, and its button
 * files an access request.
 */
export function createAllowlistMiddleware(deps: AllowlistDeps) {
  const { allowedUsersRepo, accessRequestsRepo, adminIds, notifyAdmins } = deps

  async function handleRequest(ctx: Context, userId: number): Promise<void> {
    const result = accessRequestsRepo.request(userId, ctx.from?.username, ctx.from?.first_name)
    if (result === "already_pending") {
      await ctx.answerCallbackQuery({ text: ALREADY_PENDING })
      return
    }
    if (result === "declined") {
      await ctx.answerCallbackQuery({ text: NOT_APPROVED })
      return
    }
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
      if (ctx.callbackQuery.data === ACCESS_REQUEST_DATA) {
        return handleRequest(ctx, userId)
      }
      await ctx.answerCallbackQuery({ text: INVITE_ONLY })
      return
    }

    if (!ctx.chat) return

    if (accessRequestsRepo.find(userId)?.status === "pending") {
      await smartReply(ctx, REQUEST_PENDING)
      return
    }
    await smartReply(ctx, INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  }
}

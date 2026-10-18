// src/bot/access.ts
// The access-request flow: a non-allowlisted user taps Request access (see the
// allowlist middleware), admins get a DM with Approve / Decline, and the
// decision handler here applies it.
import { InlineKeyboard, type Api, type Context } from "grammy"
import type { AccessRequest, AccessRequestsRepository } from "../db/repositories/access-requests"
import type { AllowedUsersRepository } from "../db/repositories/allowed-users"
import { HELP_TEXT } from "./help"
import { smartEdit } from "./utils/smart-reply"
import { noopAnalytics, type Analytics } from "../analytics"

export const ACCESS_REQUEST_DATA = "access:req"

export const INVITE_PROMPT = "TeleCal is invite-only while in beta. Want in?"
export const GROUP_INVITE_PROMPT =
  "TeleCal is invite-only while in beta. Message me privately to request access."
export const REQUEST_SENT = "Request sent. You'll get a message here once you're approved."
export const REQUEST_PENDING = "Your request is in. You'll get a message here once you're approved."
export const ALREADY_PENDING = "Already requested. Hang tight."
export const NOT_APPROVED = "Your request wasn't approved."
export const INVITE_ONLY = "TeleCal is invite-only."
export const APPROVED_MESSAGE = `You're in.\n\n${HELP_TEXT}`
export const DECLINED_MESSAGE = "Thanks for your interest. TeleCal can't take you on right now."

const MAX_PENDING_SHOWN = 10

/**
 * Where a stranger's request came from, for the landing page funnel: the
 * landing page links to /start access, the group DM link to /start group,
 * and anything else is someone who found the bot directly.
 */
export type AccessSource = "landing" | "group" | "bot"

export function sourceFromStart(text: string | undefined): AccessSource {
  const payload = text?.match(/^\/start(?:@\w+)?\s+(\S+)/)?.[1]
  if (payload === "access") return "landing"
  if (payload === "group") return "group"
  return "bot"
}

/** The source rides in the button's callback data, since the request is filed on the tap, not on /start. */
export function requestAccessKeyboard(source: AccessSource = "bot"): InlineKeyboard {
  const data = source === "bot" ? ACCESS_REQUEST_DATA : `${ACCESS_REQUEST_DATA}:${source}`
  return new InlineKeyboard().text("Request access", data)
}

/** Reads a Request access tap. Buttons sent before sources existed are plain "access:req". */
export function parseAccessRequest(data: string | undefined): { source: AccessSource } | null {
  if (data === ACCESS_REQUEST_DATA) return { source: "bot" }
  if (!data?.startsWith(`${ACCESS_REQUEST_DATA}:`)) return null
  const source = data.slice(ACCESS_REQUEST_DATA.length + 1)
  return { source: source === "landing" || source === "group" ? source : "bot" }
}

/** For groups: a stranger must DM the bot to request access (see GROUP_INVITE_PROMPT). */
export function privateRequestKeyboard(botUsername: string): InlineKeyboard {
  return new InlineKeyboard().url("Request access", `https://t.me/${botUsername}?start=group`)
}

export function decisionKeyboard(telegramId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve", `access:ok:${telegramId}`)
    .text("Decline", `access:no:${telegramId}`)
}

export function parseDecision(
  data: string | undefined
): { status: "approved" | "declined"; telegramId: number } | null {
  const match = data?.match(/^access:(ok|no):(\d+)$/)
  if (!match) return null
  return { status: match[1] === "ok" ? "approved" : "declined", telegramId: Number(match[2]) }
}

export function formatAccessRequest(
  req: Pick<AccessRequest, "telegram_id" | "username" | "first_name">
): string {
  const name = req.first_name?.trim() || "Unknown"
  const handle = req.username ? ` (@${req.username})` : ""
  return `Access request from id ${req.telegram_id}: ${name}${handle}`
}

export type NotifyAdmins = (req: AccessRequest) => Promise<void>

export function createAdminNotifier(api: Pick<Api, "sendMessage">, adminIds: number[]): NotifyAdmins {
  if (adminIds.length === 0) {
    console.warn("[access] ADMIN_USERS is empty: access requests will be stored but nobody can approve them")
  }
  return async (req) => {
    for (const adminId of adminIds) {
      try {
        await api.sendMessage(adminId, formatAccessRequest(req), {
          reply_markup: decisionKeyboard(req.telegram_id),
        })
      } catch (error) {
        // Usually an admin who never started the bot. /admin requests still lists it.
        console.error(`[access] could not notify admin ${adminId}:`, error)
      }
    }
  }
}

/** /admin requests: one message per pending request, each with its own buttons. */
export async function sendPendingRequests(
  repo: AccessRequestsRepository,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>
): Promise<void> {
  const pending = repo.listPending(MAX_PENDING_SHOWN)
  if (pending.length === 0) {
    await reply("No pending requests.")
    return
  }
  for (const req of pending) {
    await reply(formatAccessRequest(req), decisionKeyboard(req.telegram_id))
  }
}

export interface AccessDecisionDeps {
  accessRequestsRepo: AccessRequestsRepository
  allowedUsersRepo: AllowedUsersRepository
  adminIds: number[]
  analytics?: Analytics
}

/** Handles access: callbacks that get past the allowlist (admins and allowlisted users). */
export function createAccessDecisionHandler(deps: AccessDecisionDeps) {
  const { accessRequestsRepo, allowedUsersRepo, adminIds } = deps
  const analytics = deps.analytics ?? noopAnalytics

  return async (ctx: Context): Promise<void> => {
    const data = ctx.callbackQuery?.data
    if (parseAccessRequest(data)) {
      await ctx.answerCallbackQuery({ text: "You already have access." })
      return
    }

    const decision = parseDecision(data)
    if (!decision) {
      await ctx.answerCallbackQuery()
      return
    }

    const adminId = ctx.from?.id
    if (!adminId || !adminIds.includes(adminId)) {
      await ctx.answerCallbackQuery({ text: "Admins only." })
      return
    }

    const decided = accessRequestsRepo.decide(decision.telegramId, decision.status, adminId)
    if (!decided) {
      const current = accessRequestsRepo.find(decision.telegramId)
      await ctx.answerCallbackQuery({ text: current ? `Already ${current.status}.` : "Request not found." })
      return
    }

    if (decided.status === "approved") {
      allowedUsersRepo.add(decided.telegram_id, adminId)
    }
    analytics.capture(decided.telegram_id, decided.status === "approved" ? "access_approved" : "access_declined", {
      via: "button",
    })

    try {
      await ctx.answerCallbackQuery()
      const by = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? String(adminId)
      const verb = decided.status === "approved" ? "Approved" : "Declined"
      await smartEdit(ctx, `${formatAccessRequest(decided)}\n\n${verb} by ${by}`)
    } catch (error) {
      // The decision stands either way; keep going so the user still hears about it.
      console.error("[access] could not update the admin message:", error)
    }

    try {
      await ctx.api.sendMessage(
        decided.telegram_id,
        decided.status === "approved" ? APPROVED_MESSAGE : DECLINED_MESSAGE
      )
    } catch (error) {
      // The decision stands; the user just won't hear about it until they message the bot.
      console.error(`[access] could not message user ${decided.telegram_id}:`, error)
    }
  }
}

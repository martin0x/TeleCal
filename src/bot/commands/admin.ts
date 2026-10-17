// src/bot/commands/admin.ts
import { Context } from "grammy"
import { config } from "../../config"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { smartReply } from "../utils/smart-reply"
import { UsageRepository, type UserUsageRow, type ModelUsageRow } from "../../db/repositories/usage"
import { formatUsd, formatTokens } from "../../utils/format"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"
import { runProteinBackfill, DEFAULT_CHUNK_SIZE } from "../../jobs/backfill-protein"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import { sendPendingRequests } from "../access"
import { hashTelegramId } from "../../analytics"
import { AnnouncementsRepository } from "../../db/repositories/announcements"
import { sendAnnouncement, type AnnounceDeps } from "../../jobs/announce"

const MAX_USER_ROWS = 10

export function parseUsageWindow(arg: string | undefined): number {
  switch (arg?.toLowerCase()) {
    case "7d":
      return 7
    case "all":
      return 0
    default:
      return 30
  }
}

export function formatAdminUsage(
  users: UserUsageRow[],
  models: ModelUsageRow[],
  days: number
): string {
  const label = days === 0 ? "all time" : `last ${days} days`

  if (users.length === 0) {
    return `📊 No AI usage recorded — ${label}.`
  }

  const totalCost = users.reduce((sum, u) => sum + u.costUsd, 0)
  const totalCalls = users.reduce((sum, u) => sum + u.calls, 0)
  const totalIn = users.reduce((sum, u) => sum + u.inputTokens, 0)
  const totalOut = users.reduce((sum, u) => sum + u.outputTokens, 0)

  let message = `📊 AI Usage — ${label}\n`
  message += `Total: ${formatUsd(totalCost)} · ${totalCalls} calls · `
  message += `${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out\n\n`

  message += "By user:\n"
  const shown = users.slice(0, MAX_USER_ROWS)
  for (const u of shown) {
    const name = u.username ? ` (@${u.username})` : ""
    message += `• ${u.telegramId}${name} — ${formatUsd(u.costUsd)} · ${u.calls} calls\n`
  }

  // Telegram caps messages at 4096 characters and this bot has no shared
  // guard, so this command caps its own list rather than risk a silent failure.
  const rest = users.slice(MAX_USER_ROWS)
  if (rest.length > 0) {
    const restCost = rest.reduce((sum, u) => sum + u.costUsd, 0)
    message += `…and ${rest.length} more (${formatUsd(restCost)} total)\n`
  }

  if (models.length > 0) {
    message += "\nBy model:\n"
    for (const m of models) {
      message += `• ${m.model} — ${formatUsd(m.costUsd)} · ${m.calls} calls\n`
    }
  }

  return message.trimEnd()
}

export interface AdminDeps {
  foodLogsRepo: FoodLogsRepository
  usersRepo: UsersRepository
  aiService: AIService
  announcementsRepo: AnnouncementsRepository
}

// grammY's polling handles updates sequentially, so an admin command that
// awaits a long-running job would stall every other user's update for the
// duration. This guard makes a second /admin backfill-protein a no-op while
// one is already in flight, rather than running two overlapping backfills.
let backfillRunning = false

/**
 * /admin backfill-protein. Separated from the command so it can be tested
 * without the admin gate, which reads config.adminUsers from the environment.
 * Usage rows are attributed to the admin who ran it.
 */
export async function backfillProtein(
  deps: Pick<AdminDeps, "foodLogsRepo" | "usersRepo" | "aiService">,
  adminId: number,
  chatId: number | null,
  reply: (text: string) => Promise<void>
): Promise<void> {
  if (backfillRunning) {
    await reply("A backfill is already running — wait for its Done message.")
    return
  }
  backfillRunning = true
  try {
    const descriptions = deps.foodLogsRepo.listDescriptionsMissingProtein()
    if (descriptions.length === 0) {
      await reply("Nothing to backfill — every item has protein.")
      return
    }
    if (deps.aiService.getAvailableProviders().length === 0) {
      await reply("No AI provider configured.")
      return
    }

    const items = deps.foodLogsRepo.countItemsMissingProtein()
    const calls = Math.ceil(descriptions.length / DEFAULT_CHUNK_SIZE)
    await reply(`Backfilling protein for ${items} items across ${descriptions.length} descriptions (${calls} AI calls)…`)

    // AIService falls back to the first configured provider if this one is not available.
    const providerName = deps.usersRepo.findById(adminId)?.ai_provider ?? "gemini"
    try {
      const report = await runProteinBackfill(
        { foodLogsRepo: deps.foodLogsRepo, aiService: deps.aiService },
        { providerName, telegramId: adminId, chatId }
      )

      let done = `Done. Filled ${report.itemsFilled} items.`
      if (report.unresolved > 0) {
        done += ` ${report.unresolved} descriptions unresolved — run again to retry.`
      }
      await reply(done)
    } catch (error) {
      console.error("[backfill] failed:", error)
      await reply(
        `Backfill failed: ${error instanceof Error ? error.message : String(error)}. Nothing was lost — run /admin backfill-protein again to retry.`
      )
    }
  } finally {
    backfillRunning = false
  }
}

/** Receipts key: changing it would send the notice to everyone again. */
export const PRIVACY_ANNOUNCEMENT = "posthog-privacy-2026-10"

export function privacyNoticeText(baseUrl: string): string {
  return (
    "A privacy update from TeleCal\n\n" +
    "TeleCal is adding analytics through PostHog (servers in the US). Once it's on, PostHog receives:\n" +
    "• error reports, which can include the text of your messages\n" +
    "• for each meal estimate, what you described and the AI's reply, plus the model, cost and response time\n" +
    "• page views from the website and the charts page\n\n" +
    "You're identified by a one-way code made from your Telegram ID, never your name or username.\n\n" +
    "Nothing changes in how you use TeleCal. To have your PostHog data deleted, ask the admin who gave you access.\n\n" +
    `Details: ${baseUrl}/#privacy`
  )
}

interface AnnouncePrivacyDeps extends Omit<AnnounceDeps, "announcementsRepo"> {
  allowedUsersRepo: AllowedUsersRepository
  announcementsRepo: AnnouncementsRepository
  adminIds: number[]
}

let announceRunning = false

/**
 * /admin announce-privacy [confirm]. Without confirm it only previews, since a
 * broadcast can't be taken back. Goes to allowlisted users and admins (who pass
 * the gate without being on the allowlist), each at most once.
 */
export async function announcePrivacy(
  deps: AnnouncePrivacyDeps,
  arg: string | undefined,
  baseUrl: string,
  reply: (text: string) => Promise<void>
): Promise<void> {
  const text = privacyNoticeText(baseUrl)
  const recipients = [...new Set([...deps.allowedUsersRepo.listAll().map((u) => u.telegram_id), ...deps.adminIds])]
  const pending = recipients.filter((id) => !deps.announcementsRepo.hasReceived(PRIVACY_ANNOUNCEMENT, id))

  if (arg?.toLowerCase() !== "confirm") {
    await reply(
      `Preview of the privacy notice:\n\n${text}\n\n` +
        `It would go to ${pending.length} users (${recipients.length - pending.length} already have it). ` +
        "Send it with /admin announce-privacy confirm"
    )
    return
  }

  if (pending.length === 0) {
    await reply(`Everyone has already received the privacy notice (${recipients.length} users).`)
    return
  }
  if (announceRunning) {
    await reply("The privacy notice is already being sent — wait for its report.")
    return
  }

  announceRunning = true
  try {
    const report = await sendAnnouncement(PRIVACY_ANNOUNCEMENT, text, pending, deps)
    let message = `Privacy notice sent to ${report.sent} users.`
    if (report.failed.length > 0) {
      const lines = report.failed.map((f) => `• ${f.telegramId}: ${f.reason}`)
      message +=
        ` Couldn't reach ${report.failed.length}:\n${lines.join("\n")}\n` +
        "Run /admin announce-privacy confirm again to retry them."
    }
    await reply(message)
  } finally {
    announceRunning = false
  }
}

/** Maps a Telegram ID to its PostHog distinct ID, e.g. to delete a user's data on request. */
export function posthogIdReply(arg: string | undefined, idSecret: string): string {
  const targetId = Number(arg)
  if (!arg || !Number.isInteger(targetId)) return "Usage: /admin posthog-id <telegram_user_id>"
  if (!idSecret) return "PostHog isn't configured: POSTHOG_ID_SECRET is unset."
  return `PostHog distinct ID for ${targetId}:\n${hashTelegramId(targetId, idSecret)}`
}

export function createAdminCommand(
  repo: AllowedUsersRepository,
  usageRepo: UsageRepository,
  deps: AdminDeps,
  accessRequestsRepo: AccessRequestsRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId || !config.adminUsers.includes(userId)) {
      await smartReply(ctx, "⛔ Admin only command.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1)
    const subcommand = args[0]?.toLowerCase()

    if (!subcommand) {
      await smartReply(ctx,
        "Admin commands:\n" +
          "/admin add <user_id>\n" +
          "/admin remove <user_id>\n" +
          "/admin list\n" +
          "/admin requests\n" +
          "/admin usage [7d|30d|all]\n" +
          "/admin backfill-protein\n" +
          "/admin posthog-id <user_id>\n" +
          "/admin announce-privacy [confirm]"
      )
      return
    }

    switch (subcommand) {
      case "add": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await smartReply(ctx, "Usage: /admin add <telegram_user_id>")
          return
        }
        repo.add(targetId, userId)
        // Close any open request (pending or declined) so the two paths can't disagree.
        accessRequestsRepo.markApproved(targetId, userId)
        await smartReply(ctx, `✓ Added user ${targetId} to allowlist`)
        break
      }

      case "remove": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await smartReply(ctx, "Usage: /admin remove <telegram_user_id>")
          return
        }
        repo.remove(targetId)
        await smartReply(ctx, `✓ Removed user ${targetId} from allowlist`)
        break
      }

      case "list": {
        const users = repo.listAll()
        if (users.length === 0) {
          await smartReply(ctx, "📋 Allowlist is empty")
          return
        }
        const lines = users.map((u) => `• ${u.telegram_id}`)
        await smartReply(ctx, `📋 Allowed users:\n${lines.join("\n")}`)
        break
      }

      case "usage": {
        const days = parseUsageWindow(args[1])
        const users = usageRepo.getAllUserTotals(days)
        const models = usageRepo.getModelBreakdown(days)
        await smartReply(ctx, formatAdminUsage(users, models, days))
        break
      }

      case "backfill-protein": {
        // Runs in the background: grammY handles updates sequentially, and a full
        // backfill can take a minute. ctx.reply still works after the handler returns.
        void backfillProtein(deps, userId, ctx.chat?.id ?? null, (text) => smartReply(ctx, text)).catch((error) =>
          console.error("[backfill] unhandled:", error)
        )
        break
      }

      case "requests": {
        await sendPendingRequests(accessRequestsRepo, (text, keyboard) =>
          smartReply(ctx, text, keyboard ? { reply_markup: keyboard } : undefined)
        )
        break
      }

      case "announce-privacy": {
        const announceDeps = {
          allowedUsersRepo: repo,
          announcementsRepo: deps.announcementsRepo,
          adminIds: config.adminUsers,
          send: (telegramId: number, text: string) => ctx.api.sendMessage(telegramId, text),
        }
        // In the background, like backfill-protein: a rate-limit wait would stall every update.
        void announcePrivacy(announceDeps, args[1], config.web.baseUrl, (text) => smartReply(ctx, text)).catch((error) =>
          console.error("[announce] unhandled:", error)
        )
        break
      }

      case "posthog-id": {
        await smartReply(ctx, posthogIdReply(args[1], config.posthog.idSecret))
        break
      }

      default:
        await smartReply(ctx, `Unknown subcommand: ${subcommand}`)
    }
  }
}

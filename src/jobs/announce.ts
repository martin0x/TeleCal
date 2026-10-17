// src/jobs/announce.ts
import { GrammyError } from "grammy"
import { AnnouncementsRepository } from "../db/repositories/announcements"
import { redactUserId } from "../utils/logging"

// Telegram allows about 30 messages a second across all chats; stay under it.
const SEND_INTERVAL_MS = 50

export interface AnnounceDeps {
  announcementsRepo: AnnouncementsRepository
  send: (telegramId: number, text: string) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

export interface AnnounceReport {
  sent: number
  alreadyReceived: number
  failed: { telegramId: number; reason: string }[]
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function retryAfterMs(error: unknown): number | null {
  if (error instanceof GrammyError && error.error_code === 429) {
    return (error.parameters.retry_after ?? 1) * 1000
  }
  return null
}

function reasonFor(error: unknown): string {
  if (error instanceof GrammyError) return error.description
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sends a one-off message to each recipient who hasn't had it yet. Receipts are
 * recorded per user, so re-running after a partial failure only retries the
 * users it couldn't reach.
 */
export async function sendAnnouncement(
  announcement: string,
  text: string,
  recipients: number[],
  deps: AnnounceDeps
): Promise<AnnounceReport> {
  const sleep = deps.sleep ?? defaultSleep
  const report: AnnounceReport = { sent: 0, alreadyReceived: 0, failed: [] }
  let first = true

  for (const telegramId of new Set(recipients)) {
    if (deps.announcementsRepo.hasReceived(announcement, telegramId)) {
      report.alreadyReceived++
      continue
    }
    if (!first) await sleep(SEND_INTERVAL_MS)
    first = false

    try {
      try {
        await deps.send(telegramId, text)
      } catch (error) {
        const wait = retryAfterMs(error)
        if (wait === null) throw error
        await sleep(wait)
        await deps.send(telegramId, text)
      }
      deps.announcementsRepo.markSent(announcement, telegramId)
      report.sent++
    } catch (error) {
      console.error(`[announce] ${announcement}: could not message user ${redactUserId(telegramId)}:`, error)
      report.failed.push({ telegramId, reason: reasonFor(error) })
    }
  }

  return report
}

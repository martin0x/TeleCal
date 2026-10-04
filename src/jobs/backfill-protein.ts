// src/jobs/backfill-protein.ts
// Fills protein_g for items logged before protein tracking existed. Sends many
// descriptions per AI call so the system prompt is paid for once per chunk,
// which is where the cost is; a provider batch API would save a similar
// amount at the price of async job tracking (see the spec's Decisions table).
import type { FoodLogsRepository } from "../db/repositories/food-logs"
import type { AIService } from "../ai/service"

export interface BackfillReport {
  /** Distinct descriptions that were missing protein when the run started. */
  descriptions: number
  /** Chunks attempted, including ones that threw. */
  calls: number
  /** food_items rows updated. */
  itemsFilled: number
  /** Descriptions still without protein after the run. */
  unresolved: number
}

export interface BackfillOptions {
  providerName: string
  telegramId: number
  chatId: number | null
  chunkSize?: number
  /** Pause between chunks. Tests pass 0. */
  pauseMs?: number
}

export interface BackfillDeps {
  foodLogsRepo: Pick<FoodLogsRepository, "listDescriptionsMissingProtein" | "setProteinForDescription">
  aiService: Pick<AIService, "estimateProtein">
}

export const DEFAULT_CHUNK_SIZE = 25
export const DEFAULT_PAUSE_MS = 500

/**
 * Splits an array into chunks of the given size. Sizes below 1 are treated as 1.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step))
  }
  return out
}

/**
 * Only null rows are ever written, so running this twice is safe and a
 * partial failure is retried simply by running it again.
 */
export async function runProteinBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const descriptions = deps.foodLogsRepo.listDescriptionsMissingProtein()
  const chunks = chunk(descriptions, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS
  const report: BackfillReport = { descriptions: descriptions.length, calls: 0, itemsFilled: 0, unresolved: 0 }

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]
    report.calls++

    let protein: (number | null)[]
    try {
      protein = await deps.aiService.estimateProtein(batch, opts.providerName, {
        telegramId: opts.telegramId,
        chatId: opts.chatId,
      })
    } catch (error) {
      console.error(`[backfill] chunk ${i + 1}/${chunks.length} failed:`, error)
      report.unresolved += batch.length
      continue
    }

    batch.forEach((description, j) => {
      const grams = protein[j]
      if (grams === null || grams === undefined) {
        report.unresolved++
        return
      }
      report.itemsFilled += deps.foodLogsRepo.setProteinForDescription(description, grams)
    })

    if (pauseMs > 0 && i < chunks.length - 1) {
      await Bun.sleep(pauseMs)
    }
  }

  return report
}

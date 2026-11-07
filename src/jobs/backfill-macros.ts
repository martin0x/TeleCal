// src/jobs/backfill-macros.ts
// Fills every macro still unknown on food items: rows logged before a macro
// existed, and the odd estimate where the model left one out. Sends many
// descriptions per AI call so the system prompt is paid for once per chunk,
// which is where the cost is; a provider batch API would save a similar
// amount at the price of async job tracking (see the protein spec's Decisions).
import type { FoodLogsRepository } from "../db/repositories/food-logs"
import type { AIService } from "../ai/service"
import type { Analytics } from "../analytics"
import { MACROS, type MacroColumn, type MacroValues } from "../macros"

export interface BackfillReport {
  /** Distinct descriptions with a macro missing when the run started. */
  descriptions: number
  /** Chunks attempted, including ones that threw. */
  calls: number
  /** food_items rows that gained at least one value. */
  itemsFilled: number
  /** Descriptions in a failed chunk, or whose reply still lacked a value. */
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
  foodLogsRepo: Pick<FoodLogsRepository, "listDescriptionsMissingMacros" | "fillMissingMacros">
  aiService: Pick<AIService, "estimateMacros">
  analytics?: Analytics
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

/** The values a reply row actually has. */
function knownValues(row: MacroValues | undefined): Partial<Record<MacroColumn, number>> {
  const known: Partial<Record<MacroColumn, number>> = {}
  for (const m of MACROS) {
    const grams = row?.[m.column]
    if (typeof grams === "number") known[m.column] = grams
  }
  return known
}

/**
 * Only null cells are ever written, so running this twice is safe and a
 * partial failure is retried simply by running it again.
 */
export async function runMacroBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const descriptions = deps.foodLogsRepo.listDescriptionsMissingMacros()
  const chunks = chunk(descriptions, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS
  const report: BackfillReport = { descriptions: descriptions.length, calls: 0, itemsFilled: 0, unresolved: 0 }

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]
    report.calls++

    let values: MacroValues[]
    try {
      values = await deps.aiService.estimateMacros(batch, opts.providerName, {
        telegramId: opts.telegramId,
        chatId: opts.chatId,
      })
    } catch (error) {
      console.error(`[backfill] chunk ${i + 1}/${chunks.length} failed:`, error)
      deps.analytics?.captureException(error, opts.telegramId, { source: "backfill", chunk: i + 1, chunks: chunks.length })
      report.unresolved += batch.length
      continue
    }

    batch.forEach((description, j) => {
      const known = knownValues(values[j])
      report.itemsFilled += deps.foodLogsRepo.fillMissingMacros(description, known)
      if (Object.keys(known).length < MACROS.length) report.unresolved++
    })

    if (pauseMs > 0 && i < chunks.length - 1) {
      await Bun.sleep(pauseMs)
    }
  }

  return report
}

// src/ai/pricing.ts
import type { TokenUsage } from "./types"

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M input tokens served from cache. */
  cachedInput: number
  /** USD per 1M output tokens (reasoning tokens included). */
  output: number
}

/**
 * Prices in USD per 1M tokens. Verified 2026-09-20 against:
 *   https://developers.openai.com/api/docs/pricing
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://ai.google.dev/gemini-api/docs/pricing
 *
 * Keys must exactly match the model ids the providers request. A mismatch
 * degrades to cost 0 with a warning rather than dropping the row.
 *
 * Known simplifications (see the design doc):
 * - Cache WRITES are priced at the base input rate. gpt-5.6-luna publishes no
 *   write premium, and Anthropic's 1.25x premium applies only with explicit
 *   cache_control, which TeleCal does not use. Revisit if that changes.
 * - Gemini has no distinct cached rate here; cachedInput equals input.
 * - Batch, fast-mode, and audio rates are not modelled.
 *
 * claude-haiku-4-5-20251001 retirement is published as "not sooner than
 * 2026-10-15" — see https://github.com/martin0x/TeleCal/issues/1
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "claude-haiku-4-5-20251001": { input: 1.0, cachedInput: 0.1, output: 5.0 },
  "gemini-3.1-flash-lite": { input: 0.25, cachedInput: 0.25, output: 1.5 },
}

const warnedModels = new Set<string>()

/**
 * Cost in USD for one call. Unknown models return 0 so that token counts are
 * still recorded — "tokens tracked, cost unknown" beats losing the row.
 */
export function calculateCost(usage: TokenUsage): number {
  const price = MODEL_PRICING[usage.model]
  if (!price) {
    if (!warnedModels.has(usage.model)) {
      warnedModels.add(usage.model)
      console.warn(
        `[pricing] No price for model "${usage.model}". Recording tokens with cost 0. ` +
          `Add it to MODEL_PRICING in src/ai/pricing.ts.`
      )
    }
    return 0
  }

  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const uncached = usage.inputTokens - cached

  return (
    (uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000
  )
}

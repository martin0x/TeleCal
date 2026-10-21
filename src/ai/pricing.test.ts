// src/ai/pricing.test.ts
import { describe, test, expect } from "bun:test"
import { calculateCost, MODEL_PRICING } from "./pricing"
import type { TokenUsage } from "./types"

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { model: "gpt-5.6-luna", inputTokens: 0, outputTokens: 0, ...over }
}

describe("MODEL_PRICING", () => {
  test("covers every model the providers request", () => {
    expect(MODEL_PRICING["gpt-5.6-luna"]).toBeDefined()
    expect(MODEL_PRICING["claude-haiku-4-5-20251001"]).toBeDefined()
    expect(MODEL_PRICING["gemini-3.5-flash-lite"]).toBeDefined()
  })
})

describe("calculateCost", () => {
  test("prices exactly one million input tokens at the input rate", () => {
    expect(calculateCost(usage({ inputTokens: 1_000_000 }))).toBeCloseTo(0.2, 10)
  })

  test("prices exactly one million output tokens at the output rate", () => {
    expect(calculateCost(usage({ outputTokens: 1_000_000 }))).toBeCloseTo(1.2, 10)
  })

  test("bills cached input at the cached rate and the rest at full rate", () => {
    // 600 uncached * 0.20 + 400 cached * 0.02 + 100 output * 1.20 = 248 / 1e6
    const cost = calculateCost(
      usage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 })
    )
    expect(cost).toBeCloseTo(248 / 1_000_000, 12)
  })

  test("does not add reasoning tokens on top of output tokens", () => {
    const withReasoning = calculateCost(usage({ outputTokens: 1000, reasoningTokens: 800 }))
    const without = calculateCost(usage({ outputTokens: 1000 }))
    expect(withReasoning).toBe(without)
  })

  test("does not surcharge cache writes", () => {
    const withWrites = calculateCost(usage({ inputTokens: 1000, cacheWriteTokens: 900 }))
    const without = calculateCost(usage({ inputTokens: 1000 }))
    expect(withWrites).toBe(without)
  })

  test("returns zero for an unknown model", () => {
    const cost = calculateCost(
      usage({ model: "some-model-we-never-heard-of", inputTokens: 5000, outputTokens: 5000 })
    )
    expect(cost).toBe(0)
  })

  test("returns zero for zero tokens", () => {
    expect(calculateCost(usage())).toBe(0)
  })

  test("never returns negative cost when cached exceeds input", () => {
    // Defensive: a provider reporting cached > input must not produce a credit.
    expect(calculateCost(usage({ inputTokens: 100, cachedInputTokens: 500 }))).toBeGreaterThanOrEqual(0)
  })

  test("prices each configured model with its own rates", () => {
    const haiku = calculateCost({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(haiku).toBeCloseTo(1.0, 10)

    const gemini = calculateCost({
      model: "gemini-3.5-flash-lite",
      inputTokens: 0,
      outputTokens: 1_000_000,
    })
    expect(gemini).toBeCloseTo(2.5, 10)
  })
})

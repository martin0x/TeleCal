// src/ai/service.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { AIService, isCurrentShape } from "./service"
import { ProviderParseError, type AIProvider, type ProviderResult, type EstimationResult } from "./types"
import { calculateCost } from "./pricing"
import type { CacheRepository } from "../db/repositories/cache"
import type { UsageRepository, UsageEntry } from "../db/repositories/usage"
import { FakeAnalytics } from "../analytics/test-helpers"
import { emptyMacroValues, type MacroValues } from "../macros"

const ESTIMATE: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }],
  needsClarification: false,
  confidence: "high",
}

class FakeUsageRepo {
  rows: UsageEntry[] = []
  record(entry: UsageEntry) {
    this.rows.push(entry)
  }
}

class FakeCacheRepo {
  store = new Map<string, EstimationResult>()
  get(key: string) {
    return this.store.get(key) ?? null
  }
  set(key: string, value: EstimationResult) {
    this.store.set(key, value)
  }
}

function fakeProvider(result: ProviderResult | Error): AIProvider {
  return {
    name: "openai",
    estimate: async () => {
      if (result instanceof Error) throw result
      return result
    },
    estimateMacros: async () => {
      throw new Error("not used in this test")
    },
    parseFoods: async () => {
      throw new Error("not used in this test")
    },
  }
}

const OK_RESULT: ProviderResult = {
  estimate: ESTIMATE,
  usage: {
    model: "gpt-5.6-luna",
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 0,
  },
}

let usage: FakeUsageRepo
let cache: FakeCacheRepo
let analytics: FakeAnalytics
let service: AIService

/** Installs a fake provider, bypassing the config-driven provider map. */
function build(provider: AIProvider): AIService {
  const s = new AIService(
    cache as unknown as CacheRepository,
    usage as unknown as UsageRepository,
    analytics
  )
  // @ts-expect-error - reaching into the private provider map for testing
  s.providers.set("openai", provider)
  return s
}

beforeEach(() => {
  usage = new FakeUsageRepo()
  cache = new FakeCacheRepo()
  analytics = new FakeAnalytics()
})

const OPTS = { telegramId: 42, chatId: -100, callType: "estimate" as const }

describe("usage recording", () => {
  test("writes one row on a live call", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows).toHaveLength(1)
    const row = usage.rows[0]
    expect(row.telegramId).toBe(42)
    expect(row.chatId).toBe(-100)
    expect(row.provider).toBe("openai")
    expect(row.model).toBe("gpt-5.6-luna")
    expect(row.inputTokens).toBe(1000)
    expect(row.outputTokens).toBe(100)
    expect(row.callType).toBe("estimate")
    expect(row.status).toBe("ok")
    // 1000 * 0.20/1e6 + 100 * 1.20/1e6
    expect(row.costUsd).toBeCloseTo((1000 * 0.2 + 100 * 1.2) / 1_000_000, 12)
  })

  test("writes no row on a cache hit", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(fakeProvider(OK_RESULT))

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result).toEqual({ ...ESTIMATE, cached: true })
    expect(usage.rows).toHaveLength(0)
  })

  test("records status no_usage when the provider reports zero tokens", async () => {
    service = build(
      fakeProvider({
        estimate: ESTIMATE,
        usage: { model: "gpt-5.6-luna", inputTokens: 0, outputTokens: 0 },
      })
    )
    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows[0].status).toBe("no_usage")
  })

  test("records a parse_error row when the provider throws a SyntaxError", async () => {
    service = build(fakeProvider(new SyntaxError("Unexpected token }")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0].status).toBe("parse_error")
  })

  test("writes no row when the HTTP call itself fails", async () => {
    service = build(fakeProvider(new Error("503 Service Unavailable")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()
    expect(usage.rows).toHaveLength(0)
  })

  test("a failing usage write never breaks estimation", async () => {
    const exploding = {
      record() {
        throw new Error("disk full")
      },
    }
    const s = new AIService(
      cache as unknown as CacheRepository,
      exploding as unknown as UsageRepository
    )
    // @ts-expect-error - private map
    s.providers.set("openai", fakeProvider(OK_RESULT))

    const result = await s.estimate("chicken adobo", "openai", OPTS)
    expect(result).toEqual(ESTIMATE)
  })

  test("passes context through and marks the call type", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("200g", "openai", {
      telegramId: 1,
      chatId: 2,
      callType: "clarify",
      context: "earlier: grilled chicken",
    })

    expect(usage.rows[0].callType).toBe("clarify")
  })

  test("does not cache when context is present", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("200g", "openai", { ...OPTS, context: "earlier: chicken" })

    expect(cache.store.size).toBe(0)
  })
})

describe("macro-aware cache", () => {
  test("treats a cached result without protein_g as a miss and overwrites it", async () => {
    const stale = {
      items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high",
    } as unknown as EstimationResult
    cache.set("chicken adobo", stale)
    service = build(fakeProvider(OK_RESULT))

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result).toEqual(ESTIMATE)
    expect(usage.rows).toHaveLength(1)
    expect(cache.store.get("chicken adobo")).toEqual(ESTIMATE)
  })

  test("does not cache a result with unknown protein", async () => {
    const partial: EstimationResult = {
      ...ESTIMATE,
      items: [{ ...emptyMacroValues(), description: "Mystery", calories: 100 }],
    }
    service = build(fakeProvider({ ...OK_RESULT, estimate: partial }))

    await service.estimate("mystery", "openai", OPTS)

    expect(cache.store.size).toBe(0)
  })

  test("treats a cached result missing a newer macro as a miss", async () => {
    const { added_sugar_g, ...withoutSugar } = ESTIMATE.items[0]
    cache.set("chicken adobo", { ...ESTIMATE, items: [withoutSugar] } as unknown as EstimationResult)
    service = build(fakeProvider(OK_RESULT))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows).toHaveLength(1)
    expect(cache.store.get("chicken adobo")).toEqual(ESTIMATE)
  })
})

describe("saved foods", () => {
  const OATS = {
    id: 1,
    telegram_id: 42,
    source: "import" as const,
    name: "Quaker Oats",
    serving: "1/2 cup (40 g)",
    serving_amount: 40,
    serving_unit: "g" as const,
    calories: 150,
    protein_g: 5,
    fat_g: 3,
    fiber_g: 4,
    added_sugar_g: null,
  }

  test("go to the provider in the third argument, and the shared cache is neither read nor written", async () => {
    cache.set("oats", ESTIMATE)
    const seen: unknown[][] = []
    const provider: AIProvider = {
      name: "openai",
      estimate: async (...args: unknown[]) => {
        seen.push(args)
        return OK_RESULT
      },
      estimateMacros: async () => {
        throw new Error("not used")
      },
      parseFoods: async () => {
        throw new Error("not used")
      },
    }
    service = build(provider)

    const result = await service.estimate("oats", "openai", { ...OPTS, savedFoods: [OATS] })

    expect(result.cached).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(String(seen[0][2])).toContain("[1] Quaker Oats")
    expect([...cache.store.keys()]).toEqual(["oats"])
    expect(cache.store.get("oats")).toEqual(ESTIMATE)
  })

  test("an empty list behaves as no saved foods", async () => {
    service = build(fakeProvider(OK_RESULT))
    await service.estimate("chicken adobo", "openai", { ...OPTS, savedFoods: [] })
    expect(cache.store.has("chicken adobo")).toBe(true)
  })
})

describe("isCurrentShape", () => {
  test("is false when items is not an array", () => {
    expect(isCurrentShape({ items: "x", needsClarification: false, confidence: "high" } as unknown as EstimationResult)).toBe(false)
  })

  test("needs a number for every macro on every item", () => {
    expect(isCurrentShape(ESTIMATE)).toBe(true)
    expect(isCurrentShape({ ...ESTIMATE, items: [{ ...ESTIMATE.items[0], protein_g: null }] })).toBe(false)
  })
})

describe("estimateMacros", () => {
  function batchProvider(values: MacroValues[]): AIProvider {
    return {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => ({ values, usage: OK_RESULT.usage }),
    }
  }

  test("returns the aligned rows and records one backfill row", async () => {
    const rows = [{ ...emptyMacroValues(), protein_g: 38 }, emptyMacroValues()]
    service = build(batchProvider(rows))

    const result = await service.estimateMacros(["Chicken adobo", "Mystery"], "openai", { telegramId: 7, chatId: null })

    expect(result).toEqual(rows)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ telegramId: 7, chatId: null, callType: "backfill", status: "ok" })
  })

  test("never touches the cache", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(batchProvider([{ ...emptyMacroValues(), protein_g: 1 }]))

    await service.estimateMacros(["Chicken adobo"], "openai", { telegramId: 7, chatId: null })

    expect(cache.store.size).toBe(1)
    expect(usage.rows).toHaveLength(1)
  })

  test("records parse_error on a SyntaxError and rethrows", async () => {
    const broken: AIProvider = {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => {
        throw new SyntaxError("Unexpected token")
      },
    }
    service = build(broken)

    await expect(service.estimateMacros(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()
    expect(usage.rows[0]).toMatchObject({ callType: "backfill", status: "parse_error" })
  })
})

describe("error reporting", () => {
  test("a failed provider call is reported with the user, provider and call type", async () => {
    const error = new Error("503 Service Unavailable")
    service = build(fakeProvider(error))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()

    expect(analytics.exceptions).toEqual([
      { error, telegramId: 42, properties: { source: "ai", provider: "openai", call_type: "estimate", status: "request_failed" } },
    ])
  })

  test("an unparseable reply is reported as parse_error", async () => {
    service = build(fakeProvider(new SyntaxError("Unexpected token }")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()

    expect(analytics.exceptions[0].properties).toMatchObject({ status: "parse_error" })
  })

  test("a failed macro batch is reported with call type backfill", async () => {
    const error = new Error("timeout")
    service = build({
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => {
        throw error
      },
    })

    await expect(service.estimateMacros(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()

    expect(analytics.exceptions).toEqual([
      { error, telegramId: 7, properties: { source: "ai", provider: "openai", call_type: "backfill", status: "request_failed" } },
    ])
  })

  test("a failed usage write is reported", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("disk full")
    const s = new AIService(
      cache as unknown as CacheRepository,
      { record: () => { throw error } } as unknown as UsageRepository,
      analytics
    )
    // @ts-expect-error - private map
    s.providers.set("openai", fakeProvider(OK_RESULT))

    await s.estimate("chicken adobo", "openai", OPTS)

    expect(analytics.exceptions).toEqual([{ error, telegramId: 42, properties: { source: "usage", call_type: "estimate" } }])
    errorLog.mockRestore()
  })

  test("a successful call reports nothing", async () => {
    service = build(fakeProvider(OK_RESULT))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(analytics.exceptions).toEqual([])
  })
})

describe("$ai_generation", () => {
  const TRACE = {
    input: [
      { role: "system" as const, content: "You are a nutrition expert" },
      { role: "user" as const, content: "chicken adobo" },
    ],
    output: '{"items":[]}',
  }
  const TRACED: ProviderResult = { ...OK_RESULT, trace: TRACE }
  const generations = () => analytics.events.filter((e) => e.event === "$ai_generation")

  test("one event per billed call, with the prompt, reply, tokens, latency and our own cost", async () => {
    service = build(fakeProvider(TRACED))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(generations()).toHaveLength(1)
    const { telegramId, properties } = generations()[0]
    expect(telegramId).toBe(42)
    expect(properties).toMatchObject({
      $ai_provider: "openai",
      $ai_model: "gpt-5.6-luna",
      $ai_input_tokens: 1000,
      $ai_output_tokens: 100,
      $ai_input: TRACE.input,
      $ai_output_choices: [{ role: "assistant", content: TRACE.output }],
      $ai_total_cost_usd: calculateCost(OK_RESULT.usage),
      $ai_is_error: false,
      $ai_span_name: "estimate",
      call_type: "estimate",
      status: "ok",
    })
    expect(typeof properties?.$ai_trace_id).toBe("string")
    expect(properties?.$ai_latency).toBeGreaterThanOrEqual(0)
  })

  test("the event's cost matches the ai_usage row", async () => {
    service = build(fakeProvider(TRACED))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(generations()[0].properties?.$ai_total_cost_usd).toBe(usage.rows[0].costUsd)
  })

  test("an unparseable reply is an error event that still carries the reply and the billed tokens", async () => {
    const parseError = new ProviderParseError(new SyntaxError("Unexpected token n"), OK_RESULT.usage, { ...TRACE, output: "not json" })
    service = build(fakeProvider(parseError))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()

    expect(generations()[0].properties).toMatchObject({
      $ai_is_error: true,
      $ai_error: "Unexpected token n",
      $ai_output_choices: [{ role: "assistant", content: "not json" }],
      $ai_input_tokens: 1000,
      status: "parse_error",
    })
    // ai_usage now records the tokens that were billed, not zeros.
    expect(usage.rows[0]).toMatchObject({ status: "parse_error", inputTokens: 1000, model: "gpt-5.6-luna" })
  })

  test("a call that never got a reply sends no generation", async () => {
    service = build(fakeProvider(new Error("503 Service Unavailable")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()

    expect(generations()).toEqual([])
  })

  test("a cache hit sends no generation", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(fakeProvider(TRACED))

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(generations()).toEqual([])
  })

  test("a macro batch sends one generation with call type backfill", async () => {
    service = build({
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros: async () => ({ values: [{ ...emptyMacroValues(), protein_g: 4 }], usage: OK_RESULT.usage, trace: TRACE }),
    })

    await service.estimateMacros(["Rice"], "openai", { telegramId: 7, chatId: null })

    expect(generations()).toHaveLength(1)
    expect(generations()[0].properties).toMatchObject({ call_type: "backfill", $ai_input: TRACE.input })
  })
})

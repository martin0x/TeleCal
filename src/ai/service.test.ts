// src/ai/service.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { AIService } from "./service"
import type { AIProvider, ProviderResult, EstimationResult } from "./types"
import type { CacheRepository } from "../db/repositories/cache"
import type { UsageRepository, UsageEntry } from "../db/repositories/usage"
import { FakeAnalytics } from "../analytics/test-helpers"

const ESTIMATE: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, emoji: "🍗" }],
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
    estimateProtein: async () => {
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

    expect(result).toEqual(ESTIMATE)
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

describe("protein-aware cache", () => {
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
      items: [{ description: "Mystery", calories: 100, protein_g: null }],
    }
    service = build(fakeProvider({ ...OK_RESULT, estimate: partial }))

    await service.estimate("mystery", "openai", OPTS)

    expect(cache.store.size).toBe(0)
  })
})

describe("estimateProtein", () => {
  function batchProvider(protein: (number | null)[]): AIProvider {
    return {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => ({ protein, usage: OK_RESULT.usage }),
    }
  }

  test("returns the aligned protein array and records one backfill row", async () => {
    service = build(batchProvider([38, null]))

    const result = await service.estimateProtein(["Chicken adobo", "Mystery"], "openai", { telegramId: 7, chatId: null })

    expect(result).toEqual([38, null])
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ telegramId: 7, chatId: null, callType: "backfill", status: "ok" })
  })

  test("never touches the cache", async () => {
    cache.set("chicken adobo", ESTIMATE)
    service = build(batchProvider([1]))

    await service.estimateProtein(["Chicken adobo"], "openai", { telegramId: 7, chatId: null })

    expect(cache.store.size).toBe(1)
    expect(usage.rows).toHaveLength(1)
  })

  test("records parse_error on a SyntaxError and rethrows", async () => {
    const broken: AIProvider = {
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => {
        throw new SyntaxError("Unexpected token")
      },
    }
    service = build(broken)

    await expect(service.estimateProtein(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()
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

  test("a failed protein batch is reported with call type backfill", async () => {
    const error = new Error("timeout")
    service = build({
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => {
        throw error
      },
    })

    await expect(service.estimateProtein(["x"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()

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

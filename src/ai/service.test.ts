// src/ai/service.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { AIService } from "./service"
import type { AIProvider, ProviderResult, EstimationResult } from "./types"
import type { CacheRepository } from "../db/repositories/cache"
import type { UsageRepository, UsageEntry } from "../db/repositories/usage"

const ESTIMATE: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
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
let service: AIService

/** Installs a fake provider, bypassing the config-driven provider map. */
function build(provider: AIProvider): AIService {
  const s = new AIService(
    cache as unknown as CacheRepository,
    usage as unknown as UsageRepository
  )
  // @ts-expect-error - reaching into the private provider map for testing
  s.providers.set("openai", provider)
  return s
}

beforeEach(() => {
  usage = new FakeUsageRepo()
  cache = new FakeCacheRepo()
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

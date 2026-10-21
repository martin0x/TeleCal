// src/ai/service.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { AIService } from "./service"
import { ProviderParseError, type AIProvider, type ProviderResult, type EstimationResult } from "./types"
import { calculateCost } from "./pricing"
import type { CacheRepository } from "../db/repositories/cache"
import type { UsageRepository, UsageEntry } from "../db/repositories/usage"
import { FakeAnalytics } from "../analytics/test-helpers"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { CircuitBreaker, type CircuitEvent } from "./circuit-breaker"

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

  test("records a request_failed row, with no tokens or cost, when the HTTP call itself fails", async () => {
    service = build(fakeProvider(new Error("503 Service Unavailable")))

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      provider: "openai",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      status: "request_failed",
      error: "Error: 503 Service Unavailable",
    })
    expect(usage.rows[0].latencyMs).toBeNumber()
    // Nothing was billed, so there is no generation to report.
    expect(analytics.events.filter((e) => e.event === "$ai_generation")).toHaveLength(0)
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

  test("a protein batch sends one generation with call type backfill", async () => {
    service = build({
      name: "openai",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateProtein: async () => ({ protein: [4], usage: OK_RESULT.usage, trace: TRACE }),
    })

    await service.estimateProtein(["Rice"], "openai", { telegramId: 7, chatId: null })

    expect(generations()).toHaveLength(1)
    expect(generations()[0].properties).toMatchObject({ call_type: "backfill", $ai_input: TRACE.input })
  })
})

describe("provider fallback", () => {
  const rateLimited = () => OpenAI.APIError.generate(429, undefined, "rate limited", new Headers())
  const overloaded = () => Anthropic.APIError.generate(529, undefined, "overloaded", new Headers())

  /** A provider that answers with OK_RESULT, or throws, and remembers what it was asked. */
  function provider(name: string, outcome: ProviderResult | (() => Error)) {
    const calls: { food: string; context?: string }[] = []
    const p: AIProvider = {
      name,
      estimate: async (food, context) => {
        calls.push({ food, context })
        if (typeof outcome === "function") throw outcome()
        return outcome
      },
      estimateProtein: async () => {
        calls.push({ food: "protein" })
        if (typeof outcome === "function") throw outcome()
        return { protein: [1], usage: outcome.usage }
      },
    }
    return { p, calls }
  }

  /** Installs providers in fallback order, replacing any from config. */
  function buildChain(providers: AIProvider[], breaker = new CircuitBreaker()): AIService {
    const s = new AIService(cache as unknown as CacheRepository, usage as unknown as UsageRepository, analytics, breaker)
    // @ts-expect-error - reaching into the private provider map for testing
    s.providers = new Map(providers.map((p) => [p.name, p]))
    return s
  }

  test("the user's provider answering means no fallback", async () => {
    const openai = provider("openai", OK_RESULT)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result.fallback).toBeUndefined()
    expect(gemini.calls).toHaveLength(0)
  })

  test("starts with the user's provider, wherever it is in the order", async () => {
    const openai = provider("openai", OK_RESULT)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    await service.estimate("chicken adobo", "gemini", OPTS)

    expect(gemini.calls).toHaveLength(1)
    expect(openai.calls).toHaveLength(0)
  })

  test("a rate-limited provider falls back to the next, and says so", async () => {
    const openai = provider("openai", rateLimited)
    const anthropic = provider("anthropic", OK_RESULT)
    service = buildChain([openai.p, anthropic.p])

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result.items).toEqual(ESTIMATE.items)
    expect(result.fallback).toEqual({ from: "openai", to: "anthropic", reason: "busy" })
  })

  test("each attempt is recorded under the provider that made it", async () => {
    const openai = provider("openai", rateLimited)
    const anthropic = provider("anthropic", OK_RESULT)
    service = buildChain([openai.p, anthropic.p])

    await service.estimate("chicken adobo", "openai", OPTS)

    expect(usage.rows.map((r) => [r.provider, r.status, r.error])).toEqual([
      ["openai", "request_failed", "HTTP 429"],
      ["anthropic", "ok", null],
    ])
    const generations = analytics.events.filter((e) => e.event === "$ai_generation")
    expect(generations.map((e) => e.properties?.$ai_provider)).toEqual(["anthropic"])
  })

  test("the reason is about the user's provider, not later ones", async () => {
    const openai = provider("openai", () => new OpenAI.APIConnectionTimeoutError())
    const anthropic = provider("anthropic", overloaded)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, anthropic.p, gemini.p])

    const result = await service.estimate("chicken adobo", "openai", OPTS)

    expect(result.fallback).toEqual({ from: "openai", to: "gemini", reason: "down" })
  })

  test("a mid-clarification turn hands the same context to the fallback", async () => {
    const openai = provider("openai", overloaded)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    await service.estimate("200g", "openai", { ...OPTS, callType: "clarify", context: "Original input: \"chicken\"" })

    expect(gemini.calls).toEqual([{ food: "200g", context: "Original input: \"chicken\"" }])
  })

  test("an unparseable reply is not retried elsewhere", async () => {
    const usageOf = OK_RESULT.usage
    const openai = provider("openai", () => new ProviderParseError(new SyntaxError("x"), usageOf, { input: [], output: "" }))
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toBeInstanceOf(ProviderParseError)
    expect(gemini.calls).toHaveLength(0)
  })

  test("a config error is not retried elsewhere", async () => {
    const openai = provider("openai", () => OpenAI.APIError.generate(401, undefined, "bad key", new Headers()))
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow("bad key")
    expect(gemini.calls).toHaveLength(0)
  })

  test("when every provider fails, the last error is thrown", async () => {
    const openai = provider("openai", rateLimited)
    const gemini = provider("gemini", overloaded)
    service = buildChain([openai.p, gemini.p])

    await expect(service.estimate("chicken adobo", "openai", OPTS)).rejects.toThrow("overloaded")
    expect(usage.rows.map((r) => r.status)).toEqual(["request_failed", "request_failed"])
  })

  test("a provider skipped by the circuit breaker is not called, and the fallback says it's down", async () => {
    const events: CircuitEvent[] = []
    const breaker = new CircuitBreaker({ threshold: 2, onChange: (e) => events.push(e) })
    const openai = provider("openai", rateLimited)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p], breaker)

    await service.estimate("one", "openai", OPTS)
    await service.estimate("two", "openai", OPTS)
    const third = await service.estimate("three", "openai", OPTS)

    expect(openai.calls).toHaveLength(2)
    expect(third.fallback).toEqual({ from: "openai", to: "gemini", reason: "down" })
    expect(events.map((e) => e.type)).toEqual(["opened"])
  })

  test("with every provider skipped, nothing is called and the estimate fails", async () => {
    const breaker = new CircuitBreaker({ threshold: 1 })
    const openai = provider("openai", rateLimited)
    service = buildChain([openai.p], breaker)

    await expect(service.estimate("one", "openai", OPTS)).rejects.toThrow("rate limited")
    await expect(service.estimate("two", "openai", OPTS)).rejects.toThrow("Every AI provider is failing")
    expect(openai.calls).toHaveLength(1)
  })

  test("a provider that answers again closes its circuit", async () => {
    let clock = 0
    const events: CircuitEvent[] = []
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, now: () => clock, onChange: (e) => events.push(e) })
    let down = true
    const openai: AIProvider = {
      name: "openai",
      estimate: async () => {
        if (down) throw rateLimited()
        return OK_RESULT
      },
      estimateProtein: async () => {
        throw new Error("not used")
      },
    }
    service = buildChain([openai, provider("gemini", OK_RESULT).p], breaker)

    await service.estimate("one", "openai", OPTS)
    down = false
    clock = 1000
    const result = await service.estimate("two", "openai", OPTS)

    expect(result.fallback).toBeUndefined()
    expect(events.map((e) => e.type)).toEqual(["opened", "closed"])
  })

  test("a fallback answer is cached like any other", async () => {
    service = buildChain([provider("openai", rateLimited).p, provider("gemini", OK_RESULT).p])

    await service.estimate("chicken adobo", "openai", OPTS)
    const cached = await service.estimate("chicken adobo", "openai", OPTS)

    expect(cached.fallback).toBeUndefined()
    expect(cached.items).toEqual(ESTIMATE.items)
  })

  test("the protein backfill never falls back", async () => {
    const openai = provider("openai", rateLimited)
    const gemini = provider("gemini", OK_RESULT)
    service = buildChain([openai.p, gemini.p])

    await expect(service.estimateProtein(["Rice"], "openai", { telegramId: 7, chatId: null })).rejects.toThrow()
    expect(gemini.calls).toHaveLength(0)
  })
})

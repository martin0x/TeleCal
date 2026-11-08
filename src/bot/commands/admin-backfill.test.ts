// src/bot/commands/admin-backfill.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import type { Database } from "bun:sqlite"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { CacheRepository } from "../../db/repositories/cache"
import { UsageRepository } from "../../db/repositories/usage"
import type { AIService } from "../../ai/service"
import { ProviderParseError, type AIProvider } from "../../ai/types"
import { MACROS, emptyMacroValues, type MacroValues } from "../../macros"
import { backfillMacros, createBackfillDeps } from "./admin"
import { FakeAnalytics } from "../../analytics/test-helpers"
import { withContentPreference } from "../../analytics/content-preference"

const ADMIN = 7

let db: Database
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let replies: string[]
const reply = async (text: string) => {
  replies.push(text)
}

/** A reply row with every macro at `grams`. */
const all = (grams: number): MacroValues => ({
  ...emptyMacroValues(),
  ...Object.fromEntries(MACROS.map((m) => [m.column, grams])),
})

beforeEach(() => {
  db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(ADMIN, "admin")
  replies = []
})

function fakeAi(values: (descriptions: string[]) => MacroValues[], providers = ["gemini"]) {
  return {
    estimateMacros: mock(async (descriptions: string[]) => values(descriptions)),
    getAvailableProviders: () => providers,
    hasProvider: (name: string) => providers.includes(name),
  } as unknown as AIService
}

describe("backfillMacros", () => {
  test("reports the plan, runs, and reports the result", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
    ])
    const aiService = fakeAi(() => [all(38), all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual([
      "Backfilling macros for 3 items across 2 descriptions (1 AI calls)…",
      "Done. Filled 3 items.",
    ])
  })

  test("mentions unresolved descriptions and how to retry", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Mystery", calories: 100 }, { description: "Rice", calories: 200 }])
    const aiService = fakeAi((d) => d.map((x) => (x === "Mystery" ? emptyMacroValues() : all(4))))

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[1]).toBe("Done. Filled 1 items. 1 descriptions unresolved — run again to retry.")
  })

  test("says so when nothing is missing", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Eggs", calories: 180, ...all(12) }])
    const aiService = fakeAi(() => [])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["Nothing to backfill — every item has all its macros."])
    expect((aiService.estimateMacros as ReturnType<typeof mock>).mock.calls).toHaveLength(0)
  })

  test("refuses when no provider is configured", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [], [])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["No AI provider configured."])
  })

  test("uses the admin's provider and attributes usage to the admin", async () => {
    usersRepo.updateSettings(ADMIN, { ai_provider: "anthropic" })
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [all(4)], ["gemini", "anthropic"])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 99, reply)

    expect(aiService.estimateMacros).toHaveBeenCalledWith(["Rice"], "anthropic", { telegramId: ADMIN, chatId: 99 })
  })

  test("reports a failure instead of going silent", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.fillMissingMacros = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[0]).toStartWith("Backfilling macros for 1 items")
    expect(replies[1]).toBe("Backfill failed: disk full. Nothing was lost — run /admin backfill-macros again to retry.")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("refuses to start a second run while one is in flight", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    let release!: (v: MacroValues[]) => void
    const gate = new Promise<MacroValues[]>((r) => (release = r))
    const aiService = {
      estimateMacros: mock(() => gate),
      getAvailableProviders: () => ["gemini"],
      hasProvider: (name: string) => name === "gemini",
    } as unknown as AIService

    const first = backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2).toEqual(["A backfill is already running — wait for its Done message."])

    release([all(4)])
    await first

    expect(replies[replies.length - 1]).toBe("Done. Filled 1 items.")
  })

  test("clears the running flag after a failure", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.fillMissingMacros = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [all(4)])

    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillMacros({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2[0]).not.toBe("A backfill is already running — wait for its Done message.")
    errorSpy.mockRestore()
  })
})

describe("backfillMacros error reporting", () => {
  test("a failed run is reported as well as told to the admin", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("SQLITE_BUSY")
    let calls = 0
    // Plans fine, then fails when the run itself reads the list again.
    const brokenRepo = {
      listDescriptionsMissingMacros: () => {
        if (calls++ > 0) throw error
        return ["Rice"]
      },
      countItemsMissingMacros: () => 1,
    } as unknown as FoodLogsRepository
    const analytics = new FakeAnalytics()

    await backfillMacros(
      { foodLogsRepo: brokenRepo, usersRepo, aiService: fakeAi(() => [all(4)]), backfillAnalytics: analytics },
      ADMIN,
      1,
      reply
    )

    expect(replies.at(-1)).toStartWith("Backfill failed: SQLITE_BUSY")
    expect(analytics.exceptions).toEqual([{ error, telegramId: ADMIN, properties: { source: "backfill" } }])
    errorLog.mockRestore()
  })
})

describe("backfill analytics carry no meal text", () => {
  // The admin shares meal text; user 42 turned it off and has an item missing
  // macros. The batch is attributed to the admin, so 42's setting is never read.
  const OPTED_OUT = 42
  const USAGE = { model: "gemini-3.5-flash-lite", inputTokens: 1000, outputTokens: 100 }
  const TRACE = {
    input: [
      { role: "system" as const, content: "You are a nutrition expert" },
      { role: "user" as const, content: "1. Chicken adobo" },
    ],
    output: '{"items":[{"index":1,"description":"Chicken adobo","protein_g":38}]}',
  }

  let inner: FakeAnalytics

  beforeEach(() => {
    usersRepo.upsert(OPTED_OUT, "user42")
    usersRepo.updateSettings(OPTED_OUT, { analytics_content: false })
    foodLogsRepo.create(OPTED_OUT, OPTED_OUT, "2026-09-25", [{ description: "Chicken adobo", calories: 420 }])
    inner = new FakeAnalytics()
  })

  /** /admin's backfill deps, wired as createBot wires them, with one fake provider in place of the real ones. */
  function adminDeps(estimateMacros: AIProvider["estimateMacros"]) {
    // createBot's per-user wrapper around the PostHog client.
    const analytics = withContentPreference(inner, (id) => usersRepo.findById(id)?.analytics_content ?? true)
    const backfill = createBackfillDeps(new CacheRepository(db), new UsageRepository(db), analytics)
    const provider: AIProvider = {
      name: "gemini",
      estimate: async () => {
        throw new Error("not used")
      },
      estimateMacros,
    }
    // @ts-expect-error - replacing the private provider map, so no real API is called
    backfill.aiService.providers = new Map([["gemini", provider]])
    return { foodLogsRepo, usersRepo, ...backfill }
  }

  /** What PostHog would receive, as text: event properties, then each error's message, stack and cause. */
  const sent = () =>
    [
      JSON.stringify(inner.events),
      ...inner.exceptions.map(({ error, properties }) => {
        const e = error as Error
        return `${e.message}\n${e.stack}\n${String(e.cause ?? "")}\n${JSON.stringify(properties)}`
      }),
    ].join("\n")

  test("the batch's $ai_generation keeps tokens, cost and latency but no prompt or reply", async () => {
    await backfillMacros(
      adminDeps(async (descriptions) => ({ values: descriptions.map(() => all(38)), usage: USAGE, trace: TRACE })),
      ADMIN,
      1,
      reply
    )

    expect(replies.at(-1)).toBe("Done. Filled 1 items.")
    const generations = inner.events.filter((e) => e.event === "$ai_generation")
    expect(generations).toHaveLength(1)
    const { telegramId, properties } = generations[0]
    expect(telegramId).toBe(ADMIN)
    expect(properties).not.toHaveProperty("$ai_input")
    expect(properties).not.toHaveProperty("$ai_output_choices")
    expect(properties).toMatchObject({ $ai_input_tokens: 1000, $ai_output_tokens: 100, call_type: "backfill", status: "ok" })
    expect(properties?.$ai_total_cost_usd).toBeGreaterThan(0)
    expect(properties?.$ai_latency).toBeGreaterThanOrEqual(0)
    expect(sent()).not.toContain("Chicken")
  })

  test("an unparseable reply is reported with its tokens but without the description or the raw message", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const parseError = new ProviderParseError(new SyntaxError('JSON Parse error: Unexpected identifier "Chicken"'), USAGE, {
      ...TRACE,
      output: "Chicken adobo: about 38 g protein",
    })

    await backfillMacros(
      adminDeps(async () => {
        throw parseError
      }),
      ADMIN,
      1,
      reply
    )

    expect(replies.at(-1)).toBe("Done. Filled 0 items. 1 descriptions unresolved — run again to retry.")
    const [generation] = inner.events.filter((e) => e.event === "$ai_generation")
    expect(generation.properties).toMatchObject({ $ai_is_error: true, $ai_input_tokens: 1000, status: "parse_error" })
    for (const key of ["$ai_input", "$ai_output_choices", "$ai_error"]) expect(generation.properties).not.toHaveProperty(key)
    // AIService reports it, then the job does: the same copy both times, so PostHog still gets it once.
    expect(inner.exceptions.map((e) => e.properties)).toEqual([
      { source: "ai", provider: "gemini", call_type: "backfill", status: "parse_error" },
      { source: "backfill", chunk: 1, chunks: 1 },
    ])
    expect(inner.exceptions[1].error).toBe(inner.exceptions[0].error)
    const reported = inner.exceptions[0].error as Error
    expect(reported.name).toBe("ProviderParseError")
    expect(reported.message).toBe("[redacted]")
    expect(sent()).not.toContain("Chicken")
    errorLog.mockRestore()
  })

  test("a failed run is reported without its message", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.fillMissingMacros = () => {
      throw new Error('no room for "Chicken adobo"')
    }

    await backfillMacros(adminDeps(async (descriptions) => ({ values: descriptions.map(() => all(38)), usage: USAGE })), ADMIN, 1, reply)

    expect(replies.at(-1)).toStartWith("Backfill failed:")
    expect(inner.exceptions).toHaveLength(1)
    const [{ error, telegramId, properties }] = inner.exceptions
    expect(telegramId).toBe(ADMIN)
    expect(properties).toEqual({ source: "backfill" })
    expect((error as Error).message).toBe("[redacted]")
    expect(sent()).not.toContain("Chicken")
    errorLog.mockRestore()
  })
})

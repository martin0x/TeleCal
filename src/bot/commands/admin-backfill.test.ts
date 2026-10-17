// src/bot/commands/admin-backfill.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import { backfillProtein } from "./admin"
import { FakeAnalytics } from "../../analytics/test-helpers"

const ADMIN = 7

let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let replies: string[]
const reply = async (text: string) => {
  replies.push(text)
}

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(ADMIN, "admin")
  replies = []
})

function fakeAi(protein: (descriptions: string[]) => (number | null)[], providers = ["gemini"]) {
  return {
    estimateProtein: mock(async (descriptions: string[]) => protein(descriptions)),
    getAvailableProviders: () => providers,
    hasProvider: (name: string) => providers.includes(name),
  } as unknown as AIService
}

describe("backfillProtein", () => {
  test("reports the plan, runs, and reports the result", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
    ])
    const aiService = fakeAi(() => [38, 4])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual([
      "Backfilling protein for 3 items across 2 descriptions (1 AI calls)…",
      "Done. Filled 3 items.",
    ])
  })

  test("mentions unresolved descriptions and how to retry", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Mystery", calories: 100 }, { description: "Rice", calories: 200 }])
    const aiService = fakeAi((d) => d.map((x) => (x === "Mystery" ? null : 4)))

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[1]).toBe("Done. Filled 1 items. 1 descriptions unresolved — run again to retry.")
  })

  test("says so when nothing is missing", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    const aiService = fakeAi(() => [])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["Nothing to backfill — every item has protein."])
    expect((aiService.estimateProtein as ReturnType<typeof mock>).mock.calls).toHaveLength(0)
  })

  test("refuses when no provider is configured", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [], [])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies).toEqual(["No AI provider configured."])
  })

  test("uses the admin's provider and attributes usage to the admin", async () => {
    usersRepo.updateSettings(ADMIN, { ai_provider: "anthropic" })
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const aiService = fakeAi(() => [4], ["gemini", "anthropic"])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 99, reply)

    expect(aiService.estimateProtein).toHaveBeenCalledWith(["Rice"], "anthropic", { telegramId: ADMIN, chatId: 99 })
  })

  test("reports a failure instead of going silent", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.setProteinForDescription = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [4])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    expect(replies[0]).toStartWith("Backfilling protein for 1 items")
    expect(replies[1]).toBe("Backfill failed: disk full. Nothing was lost — run /admin backfill-protein again to retry.")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("refuses to start a second run while one is in flight", async () => {
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    let release!: (v: (number | null)[]) => void
    const gate = new Promise<(number | null)[]>((r) => (release = r))
    const aiService = {
      estimateProtein: mock(() => gate),
      getAvailableProviders: () => ["gemini"],
      hasProvider: (name: string) => name === "gemini",
    } as unknown as AIService

    const first = backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2).toEqual(["A backfill is already running — wait for its Done message."])

    release([4])
    await first

    expect(replies[replies.length - 1]).toBe("Done. Filled 1 items.")
  })

  test("clears the running flag after a failure", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(ADMIN, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    foodLogsRepo.setProteinForDescription = () => {
      throw new Error("disk full")
    }
    const aiService = fakeAi(() => [4])

    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply)

    const replies2: string[] = []
    const reply2 = async (text: string) => {
      replies2.push(text)
    }
    await backfillProtein({ foodLogsRepo, usersRepo, aiService }, ADMIN, 1, reply2)

    expect(replies2[0]).not.toBe("A backfill is already running — wait for its Done message.")
    errorSpy.mockRestore()
  })
})

describe("backfillProtein error reporting", () => {
  test("a failed run is reported as well as told to the admin", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("SQLITE_BUSY")
    let calls = 0
    // Plans fine, then fails when the run itself reads the list again.
    const brokenRepo = {
      listDescriptionsMissingProtein: () => {
        if (calls++ > 0) throw error
        return ["Rice"]
      },
      countItemsMissingProtein: () => 1,
    } as unknown as FoodLogsRepository
    const analytics = new FakeAnalytics()

    await backfillProtein({ foodLogsRepo: brokenRepo, usersRepo, aiService: fakeAi(() => [4]), analytics }, ADMIN, 1, reply)

    expect(replies.at(-1)).toStartWith("Backfill failed: SQLITE_BUSY")
    expect(analytics.exceptions).toEqual([{ error, telegramId: ADMIN, properties: { source: "backfill" } }])
    errorLog.mockRestore()
  })
})

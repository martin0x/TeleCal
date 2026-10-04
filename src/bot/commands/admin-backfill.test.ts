// src/bot/commands/admin-backfill.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import { backfillProtein } from "./admin"

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
})

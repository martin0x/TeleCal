// src/jobs/backfill-protein.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { chunk, runProteinBackfill } from "./backfill-protein"

let foodLogsRepo: FoodLogsRepository
let db: any

beforeEach(() => {
  db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  db.run("INSERT INTO users (telegram_id) VALUES (1)")
})

const OPTS = { providerName: "gemini", telegramId: 1, chatId: null, pauseMs: 0 }

describe("chunk", () => {
  test("splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe("runProteinBackfill", () => {
  test("fills only null rows, matching by exact description", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
      { description: "Eggs", calories: 180, protein_g: 12 },
    ])
    const estimateProtein = mock(async (descriptions: string[]) =>
      descriptions.map((d) => (d === "Rice" ? 4 : 38))
    )

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(estimateProtein).toHaveBeenCalledTimes(1)
    expect(estimateProtein).toHaveBeenCalledWith(["Chicken adobo", "Rice"], "gemini", { telegramId: 1, chatId: null })
    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 3, unresolved: 0 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25").map((i) => i.protein_g)).toEqual([38, 38, 4, 12])
  })

  test("counts null answers as unresolved and leaves those rows null", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Mystery", calories: 100 },
      { description: "Rice", calories: 200 },
    ])
    const estimateProtein = mock(async (descriptions: string[]) => descriptions.map((d) => (d === "Mystery" ? null : 4)))

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.listDescriptionsMissingProtein()).toEqual(["Mystery"])
  })

  test("chunks by chunkSize and keeps going when one chunk throws", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "A", calories: 1 },
      { description: "B", calories: 1 },
      { description: "C", calories: 1 },
      { description: "D", calories: 1 },
      { description: "E", calories: 1 },
    ])
    let call = 0
    const estimateProtein = mock(async (descriptions: string[]) => {
      call++
      if (call === 2) throw new Error("503")
      return descriptions.map(() => 10)
    })

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, { ...OPTS, chunkSize: 2 })

    expect(estimateProtein).toHaveBeenCalledTimes(3)
    expect(report).toEqual({ descriptions: 5, calls: 3, itemsFilled: 3, unresolved: 2 })
    expect(foodLogsRepo.listDescriptionsMissingProtein()).toEqual(["C", "D"])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("makes no calls when nothing is missing", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    const estimateProtein = mock(async () => [])

    const report = await runProteinBackfill({ foodLogsRepo, aiService: { estimateProtein } }, OPTS)

    expect(estimateProtein).not.toHaveBeenCalled()
    expect(report).toEqual({ descriptions: 0, calls: 0, itemsFilled: 0, unresolved: 0 })
  })
})

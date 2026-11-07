// src/jobs/backfill-macros.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { MACROS, emptyMacroValues, type MacroValues } from "../macros"
import { chunk, runMacroBackfill } from "./backfill-macros"
import { FakeAnalytics } from "../analytics/test-helpers"

let foodLogsRepo: FoodLogsRepository
let db: any

beforeEach(() => {
  db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  db.run("INSERT INTO users (telegram_id) VALUES (1)")
})

const OPTS = { providerName: "gemini", telegramId: 1, chatId: null, pauseMs: 0 }

/** A reply row with every macro at `grams`. */
const all = (grams: number): MacroValues => ({
  ...emptyMacroValues(),
  ...Object.fromEntries(MACROS.map((m) => [m.column, grams])),
})

describe("chunk", () => {
  test("splits into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })

  test("treats a size below 1 as 1 instead of looping forever", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]])
    expect(chunk([1, 2], -5)).toEqual([[1], [2]])
  })
})

describe("runMacroBackfill", () => {
  test("fills only missing values, matching by exact description", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Chicken adobo", calories: 420 },
      { description: "Chicken adobo", calories: 450 },
      { description: "Rice", calories: 200 },
      { description: "Eggs", calories: 180, ...all(12) },
    ])
    const estimateMacros = mock(async (descriptions: string[]) => descriptions.map((d) => all(d === "Rice" ? 4 : 38)))

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(estimateMacros).toHaveBeenCalledTimes(1)
    expect(estimateMacros).toHaveBeenCalledWith(["Chicken adobo", "Rice"], "gemini", { telegramId: 1, chatId: null })
    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 3, unresolved: 0 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25").map((i) => i.protein_g)).toEqual([38, 38, 4, 12])
  })

  test("never overwrites a value that is already there", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Ramen", calories: 520, protein_g: 30 }])
    const estimateMacros = mock(async (descriptions: string[]) => descriptions.map(() => all(5)))

    await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25")[0].protein_g).toBe(30)
  })

  test("counts a description whose reply lacks a value as unresolved", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [
      { description: "Mystery", calories: 100 },
      { description: "Rice", calories: 200 },
    ])
    const estimateMacros = mock(async (descriptions: string[]) =>
      descriptions.map((d) => (d === "Mystery" ? emptyMacroValues() : all(4)))
    )

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(report).toEqual({ descriptions: 2, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.listDescriptionsMissingMacros()).toEqual(["Mystery"])
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
    const estimateMacros = mock(async (descriptions: string[]) => {
      call++
      if (call === 2) throw new Error("503")
      return descriptions.map(() => all(10))
    })

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, { ...OPTS, chunkSize: 2 })

    expect(estimateMacros).toHaveBeenCalledTimes(3)
    expect(report).toEqual({ descriptions: 5, calls: 3, itemsFilled: 3, unresolved: 2 })
    expect(foodLogsRepo.listDescriptionsMissingMacros()).toEqual(["C", "D"])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("makes no calls when nothing is missing", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Eggs", calories: 180, ...all(12) }])
    const estimateMacros = mock(async () => [] as MacroValues[])

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(estimateMacros).not.toHaveBeenCalled()
    expect(report).toEqual({ descriptions: 0, calls: 0, itemsFilled: 0, unresolved: 0 })
  })

  test("a reply row with only some values fills those and stays unresolved", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const estimateMacros = mock(async () => [{ ...emptyMacroValues(), protein_g: 4, fiber_g: 1 }])

    const report = await runMacroBackfill({ foodLogsRepo, aiService: { estimateMacros } }, OPTS)

    expect(report).toEqual({ descriptions: 1, calls: 1, itemsFilled: 1, unresolved: 1 })
    expect(foodLogsRepo.getItemsByDate(1, "2026-09-25")[0]).toMatchObject({ protein_g: 4, fiber_g: 1, fat_g: null, added_sugar_g: null })
  })
})

describe("runMacroBackfill error reporting", () => {
  test("a failed chunk is reported and the run carries on", async () => {
    foodLogsRepo.create(1, 1, "2026-09-25", [{ description: "Rice", calories: 200 }])
    const error = new Error("timeout")
    const analytics = new FakeAnalytics()
    const errorLog = spyOn(console, "error").mockImplementation(() => {})

    const report = await runMacroBackfill(
      { foodLogsRepo, aiService: { estimateMacros: mock(() => Promise.reject(error)) } as any, analytics },
      OPTS
    )

    expect(report.unresolved).toBe(1)
    expect(analytics.exceptions).toEqual([{ error, telegramId: 1, properties: { source: "backfill", chunk: 1, chunks: 1 } }])
    errorLog.mockRestore()
  })
})

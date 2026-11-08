import { describe, test, expect, mock } from "bun:test"
import { MealEstimator } from "./estimator"
import { FakeAnalytics } from "../analytics/test-helpers"
import type { AIService } from "../ai/service"
import type { EstimationResult } from "../ai/types"
import type { SavedFood } from "./types"

const OATS: SavedFood = {
  id: 1,
  telegram_id: 42,
  source: "import",
  name: "Quaker Oats",
  serving: "1/2 cup (40 g)",
  serving_amount: 40,
  serving_unit: "g",
  calories: 150,
  protein_g: 5,
  fat_g: 3,
  fiber_g: 4,
  added_sugar_g: null,
}

const BANANA = { description: "Banana", calories: 105, protein_g: 1, fat_g: 0, fiber_g: 3, added_sugar_g: 0, emoji: "🍌" }
const BANANA_REPLY: EstimationResult = { items: [BANANA], needsClarification: false, confidence: "high" }
const OPTS = { telegramId: 42, chatId: 7, callType: "estimate" as const }

function build(opts: { enabled?: boolean; foods?: SavedFood[]; reply?: EstimationResult; listThrows?: boolean } = {}) {
  const analytics = new FakeAnalytics()
  const ai = { estimate: mock(async (..._args: unknown[]) => opts.reply ?? BANANA_REPLY) }
  const library = {
    listByUser: mock(() => {
      if (opts.listThrows) throw new Error("db gone")
      return opts.foods ?? [OATS]
    }),
  }
  const estimator = new MealEstimator({
    enabled: opts.enabled ?? true,
    library,
    ai: ai as unknown as Pick<AIService, "estimate">,
    analytics,
  })
  return { estimator, ai, library, analytics }
}

describe("MealEstimator", () => {
  test("flag off: a plain AI call, the library untouched", async () => {
    const { estimator, ai, library } = build({ enabled: false })
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
    expect(library.listByUser).not.toHaveBeenCalled()
    expect(result.source).toBe("ai")
    expect(result.items).toEqual([BANANA])
  })

  test("an empty library: a plain AI call", async () => {
    const { estimator, ai } = build({ foods: [] })
    await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
  })

  test("a fully matched meal makes no AI call", async () => {
    const { estimator, ai, analytics } = build()
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(ai.estimate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ source: "library", needsClarification: false })
    expect(result.items).toEqual([
      { description: "Quaker Oats ×2", calories: 300, protein_g: 10, fat_g: 6, fiber_g: 8, added_sugar_g: null, saved_food_id: 1 },
    ])
    expect(analytics.events).toEqual([
      { telegramId: 42, event: "meal_estimated", properties: { source: "library", saved_foods_used: 1, clarification: false } },
    ])
  })

  test("a mixed meal: candidates go to the AI, label values replace its numbers, blanks keep the AI's", async () => {
    const reply: EstimationResult = {
      items: [
        { description: "Oatmeal", calories: 200, protein_g: 7, fat_g: 4, fiber_g: 5, added_sugar_g: 2, emoji: "🥣", saved_food_id: 1, servings: 2 },
        { ...BANANA, saved_food_id: null, servings: null },
      ],
      needsClarification: false,
      confidence: "medium",
    }
    const { estimator, ai } = build({ reply })
    const result = await estimator.estimate("80g oats and a banana", "openai", OPTS)

    expect(ai.estimate).toHaveBeenCalledWith("80g oats and a banana", "openai", { ...OPTS, savedFoods: [OATS] })
    expect(result.source).toBe("mixed")
    expect(result.items[0]).toEqual({
      description: "Quaker Oats ×2",
      calories: 300,
      protein_g: 10,
      fat_g: 6,
      fiber_g: 8,
      added_sugar_g: 2,
      emoji: "🥣",
      saved_food_id: 1,
    })
    expect(result.items[1]).toEqual({ ...BANANA, saved_food_id: null })
  })

  test("an id that was not a candidate, or servings that aren't positive, keep the AI's numbers", async () => {
    const reply: EstimationResult = {
      items: [
        { description: "Oatmeal", calories: 200, protein_g: 7, fat_g: 4, fiber_g: 5, added_sugar_g: 2, saved_food_id: 99, servings: 2 },
        { description: "Oats", calories: 180, protein_g: 6, fat_g: 3, fiber_g: 4, added_sugar_g: 0, saved_food_id: 1, servings: 0 },
      ],
      needsClarification: false,
      confidence: "medium",
    }
    const { estimator } = build({ reply })
    const result = await estimator.estimate("oats and oatmeal bowl", "openai", OPTS)
    expect(result.source).toBe("ai")
    expect(result.items.map((i) => [i.calories, i.saved_food_id])).toEqual([[200, null], [180, null]])
    expect(result.items.every((i) => !("servings" in i))).toBe(true)
  })

  test("a clarification reply never takes the code-only path", async () => {
    const { estimator, ai } = build()
    await estimator.estimate("2 oats", "openai", { ...OPTS, callType: "clarify", context: 'Original input: "oats"' })
    expect(ai.estimate).toHaveBeenCalledWith(
      "2 oats",
      "openai",
      expect.objectContaining({ context: 'Original input: "oats"', savedFoods: [OATS] })
    )
  })

  test("LogFlow's context labels don't pick saved foods", async () => {
    const pringles: SavedFood = { ...OATS, id: 2, name: "Pringles Original" }
    const { estimator, ai } = build({ foods: [OATS, pringles] })
    const opts = { ...OPTS, callType: "clarify" as const, context: 'Original input: "banana"' }
    await estimator.estimate("banana", "openai", opts)
    expect(ai.estimate).toHaveBeenCalledWith("banana", "openai", opts)
  })

  test("a failed call with saved foods is reported and retried once as a plain estimate", async () => {
    const { estimator, ai, analytics } = build()
    const failure = new Error("schema rejected")
    ai.estimate.mockImplementationOnce(async () => {
      throw failure
    })
    const result = await estimator.estimate("80g oats and a banana", "openai", OPTS)

    expect(ai.estimate).toHaveBeenCalledTimes(2)
    expect(ai.estimate.mock.calls[0]).toEqual(["80g oats and a banana", "openai", { ...OPTS, savedFoods: [OATS] }])
    expect(ai.estimate.mock.calls[1]).toEqual(["80g oats and a banana", "openai", OPTS])
    expect(result.source).toBe("ai")
    expect(result.items).toEqual([BANANA])
    expect(analytics.exceptions).toHaveLength(1)
    expect(analytics.exceptions[0]).toMatchObject({ error: failure, telegramId: 42, properties: { source: "library" } })
  })

  test("when the plain retry fails too, the error reaches the caller", async () => {
    const { estimator, ai } = build()
    ai.estimate.mockImplementation(async () => {
      throw new Error("AI down")
    })
    await expect(estimator.estimate("80g oats and a banana", "openai", OPTS)).rejects.toThrow("AI down")
    expect(ai.estimate).toHaveBeenCalledTimes(2)
  })

  test("no relevant saved food: a plain AI call; a cache hit reports source cache", async () => {
    const { estimator, ai } = build({ reply: { ...BANANA_REPLY, cached: true } })
    const result = await estimator.estimate("banana", "openai", OPTS)
    expect(ai.estimate).toHaveBeenCalledWith("banana", "openai", OPTS)
    expect(result.source).toBe("cache")
  })

  test("a library error is reported and the estimate falls back to a plain AI call", async () => {
    const { estimator, ai, analytics } = build({ listThrows: true })
    const result = await estimator.estimate("2 oats", "openai", OPTS)
    expect(analytics.exceptions[0]).toMatchObject({ telegramId: 42, properties: { source: "library" } })
    expect(ai.estimate).toHaveBeenCalledWith("2 oats", "openai", OPTS)
    expect(result.source).toBe("ai")
  })
})

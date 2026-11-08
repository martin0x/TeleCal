// src/ai/prompt.test.ts
import { describe, test, expect } from "bun:test"
import { MACROS } from "../macros"
import {
  ESTIMATE_JSON_PROMPT,
  MACRO_BATCH_PROMPT,
  MACRO_RULES,
  estimateUserMessage,
  formatSavedFoods,
  SAVED_FOODS_HEADER,
} from "./prompt"

describe("prompts", () => {
  test("MACRO_RULES is every registry rule, in order", () => {
    expect(MACRO_RULES).toBe(MACROS.map((m) => m.rule).join("\n"))
  })

  test("the estimate prompt asks for every macro and shows each in its example", () => {
    expect(ESTIMATE_JSON_PROMPT).toStartWith(
      "You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food."
    )
    expect(ESTIMATE_JSON_PROMPT).toContain("{description, calories, protein_g, fat_g, fiber_g, added_sugar_g, emoji}")
    expect(ESTIMATE_JSON_PROMPT).toContain(MACRO_RULES)
    for (const m of MACROS) expect(ESTIMATE_JSON_PROMPT).toContain(`"${m.column}":`)
  })

  test("the batch prompt asks for every macro on every line", () => {
    expect(MACRO_BATCH_PROMPT).toContain(MACRO_RULES)
    for (const m of MACROS) expect(MACRO_BATCH_PROMPT).toContain(`"${m.column}":`)
  })
})

describe("saved foods", () => {
  const OATS = {
    id: 12,
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

  test("formatSavedFoods lists each food's label values and asks for saved_food_id and servings", () => {
    const block = formatSavedFoods([OATS])
    expect(block.split("\n")[0]).toBe(SAVED_FOODS_HEADER)
    expect(block).toContain(
      "[12] Quaker Oats, serving 1/2 cup (40 g): 150 kcal, protein 5 g, fat 3 g, fiber 4 g, added sugar not on label"
    )
    expect(block).toContain("saved_food_id")
    expect(block).toContain("servings")
  })

  test("estimateUserMessage is unchanged without saved foods, and appends them otherwise", () => {
    expect(estimateUserMessage("oats")).toBe("oats")
    expect(estimateUserMessage("oats", "Original input: \"x\"")).toBe(
      "Context from previous conversation: Original input: \"x\"\n\nFood to estimate: oats"
    )
    expect(estimateUserMessage("oats", undefined, "BLOCK")).toBe("oats\n\nBLOCK")
  })

  test("the system prompt does not mention saved foods", () => {
    expect(ESTIMATE_JSON_PROMPT).not.toContain("saved_food_id")
  })
})

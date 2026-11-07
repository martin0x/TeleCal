// src/ai/prompt.test.ts
import { describe, test, expect } from "bun:test"
import { MACROS } from "../macros"
import { ESTIMATE_JSON_PROMPT, MACRO_BATCH_PROMPT, MACRO_RULES } from "./prompt"

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

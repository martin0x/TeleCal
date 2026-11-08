// src/ai/parse.test.ts
import { describe, test, expect } from "bun:test"
import { coerceGrams, normalizeItems, stripFences, alignMacroBatch, normalizeFoodsReply } from "./parse"
import { MACROS, emptyMacroValues, type MacroValues } from "../macros"

describe("coerceGrams", () => {
  test("rounds finite numbers to whole grams and clamps at zero", () => {
    expect(coerceGrams(14)).toBe(14)
    expect(coerceGrams(13.6)).toBe(14)
    expect(coerceGrams(0)).toBe(0)
    expect(coerceGrams(-3)).toBe(0)
  })

  test("accepts a numeric string", () => {
    expect(coerceGrams("22")).toBe(22)
    expect(coerceGrams(" 7.4 ")).toBe(7)
  })

  test("returns null for anything else", () => {
    expect(coerceGrams(undefined)).toBeNull()
    expect(coerceGrams(null)).toBeNull()
    expect(coerceGrams("lots")).toBeNull()
    expect(coerceGrams("")).toBeNull()
    expect(coerceGrams(Number.NaN)).toBeNull()
    expect(coerceGrams(Number.POSITIVE_INFINITY)).toBeNull()
    expect(coerceGrams({})).toBeNull()
  })

  test("drops values above 1000 g, which are garbage rather than food", () => {
    expect(coerceGrams(1000)).toBe(1000)
    expect(coerceGrams(1001)).toBeNull()
    expect(coerceGrams("5000")).toBeNull()
  })
})

describe("normalizeItems", () => {
  test("coerces protein_g on every item and keeps other fields", () => {
    expect(
      normalizeItems([
        { description: "Eggs", calories: 180, protein_g: 12.4, emoji: "🍳" },
        { description: "Rice", calories: 200 },
      ])
    ).toEqual([
      { ...emptyMacroValues(), description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { ...emptyMacroValues(), description: "Rice", calories: 200 },
    ])
  })

  test("returns an empty array for a missing or non-array items field", () => {
    expect(normalizeItems(undefined)).toEqual([])
    expect(normalizeItems("nope")).toEqual([])
  })

  test("drops array elements that are not objects", () => {
    expect(normalizeItems([null, "x", 7, { description: "Rice", calories: 200, protein_g: 4 }])).toEqual([
      { ...emptyMacroValues(), description: "Rice", calories: 200, protein_g: 4 },
    ])
  })

  test("coerces every registry column", () => {
    const raw = Object.fromEntries(MACROS.map((m, i) => [m.column, `${i + 1}.4`]))
    expect(normalizeItems([{ description: "X", calories: 1, ...raw }])).toEqual([
      { description: "X", calories: 1, ...(Object.fromEntries(MACROS.map((m, i) => [m.column, i + 1])) as MacroValues) },
    ])
  })

  test("coerces fat, fiber and added sugar", () => {
    expect(
      normalizeItems([{ description: "Adobo", calories: 420, protein_g: 38, fat_g: "24.4", fiber_g: 1.2, added_sugar_g: "lots" }])
    ).toEqual([{ description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: null }])
  })
})

describe("stripFences", () => {
  test("removes a ```json fence", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
  })

  test("leaves bare JSON alone", () => {
    expect(stripFences('  {"a":1} ')).toBe('{"a":1}')
  })
})

describe("alignMacroBatch", () => {
  const v = (partial: Partial<MacroValues>): MacroValues => ({ ...emptyMacroValues(), ...partial })

  test("maps entries back onto inputs by 1-based index, coercing every column", () => {
    const reply = { items: [{ index: 2, protein_g: 4 }, { index: 1, protein_g: 28.2 }] }
    expect(alignMacroBatch(reply, 2)).toEqual([v({ protein_g: 28 }), v({ protein_g: 4 })])
  })

  test("leaves missing and out-of-range indices empty", () => {
    const reply = { items: [{ index: 1, protein_g: 10 }, { index: 5, protein_g: 99 }, { index: "2", protein_g: 3 }] }
    expect(alignMacroBatch(reply, 3)).toEqual([v({ protein_g: 10 }), emptyMacroValues(), emptyMacroValues()])
  })

  test("returns empty rows for garbage", () => {
    expect(alignMacroBatch(null, 2)).toEqual([emptyMacroValues(), emptyMacroValues()])
    expect(alignMacroBatch({ items: "x" }, 2)).toEqual([emptyMacroValues(), emptyMacroValues()])
    expect(alignMacroBatch({ items: [null, 7] }, 1)).toEqual([emptyMacroValues()])
  })

  test("keeps the values a row has and nulls the rest", () => {
    const reply = { items: [{ index: 1, protein_g: 14, fat_g: 10, fiber_g: 0 }] }
    expect(alignMacroBatch(reply, 1)).toEqual([{ protein_g: 14, fat_g: 10, fiber_g: 0, added_sugar_g: null }])
  })
})

describe("normalizeItems: saved foods", () => {
  test("keeps saved_food_id and servings when the model sent them, coercing bad values to null", () => {
    const [a, b, c] = normalizeItems([
      { description: "Oats", calories: 300, saved_food_id: 12, servings: 2 },
      { description: "Banana", calories: 105, saved_food_id: null, servings: null },
      { description: "Rice", calories: 200, saved_food_id: "7", servings: -1 },
    ])
    expect([a.saved_food_id, a.servings]).toEqual([12, 2])
    expect([b.saved_food_id, b.servings]).toEqual([null, null])
    expect([c.saved_food_id, c.servings]).toEqual([7, null])
  })

  test("adds neither field when the model did not send them", () => {
    const [item] = normalizeItems([{ description: "Eggs", calories: 180 }])
    expect("saved_food_id" in item).toBe(false)
    expect("servings" in item).toBe(false)
  })
})

describe("normalizeFoodsReply", () => {
  test("keeps object rows raw and turns unreadable entries into strings", () => {
    expect(
      normalizeFoodsReply({
        foods: [{ name: "Oats", calories: 150 }, "junk", null],
        unreadable: [{ text: "lunch adobo", reason: "no calories" }, { text: "" }, { text: 7 }],
      })
    ).toEqual({
      foods: [{ name: "Oats", calories: 150 }],
      unreadable: [
        { text: "lunch adobo", reason: "no calories" },
        { text: "7", reason: "unreadable" },
      ],
    })
  })

  test("anything else becomes empty lists", () => {
    expect(normalizeFoodsReply(null)).toEqual({ foods: [], unreadable: [] })
    expect(normalizeFoodsReply({ foods: "x" })).toEqual({ foods: [], unreadable: [] })
  })
})

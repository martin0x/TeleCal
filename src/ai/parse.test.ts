// src/ai/parse.test.ts
import { describe, test, expect } from "bun:test"
import { coerceGrams, normalizeItems, stripFences, alignProteinBatch } from "./parse"
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
})

describe("stripFences", () => {
  test("removes a ```json fence", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
  })

  test("leaves bare JSON alone", () => {
    expect(stripFences('  {"a":1} ')).toBe('{"a":1}')
  })
})

describe("alignProteinBatch", () => {
  test("maps entries back onto inputs by 1-based index", () => {
    const reply = { items: [{ index: 2, protein_g: 4 }, { index: 1, protein_g: 28.2 }] }
    expect(alignProteinBatch(reply, 2)).toEqual([28, 4])
  })

  test("leaves missing, duplicate-free gaps and out-of-range indices as null", () => {
    const reply = { items: [{ index: 1, protein_g: 10 }, { index: 5, protein_g: 99 }, { index: "2", protein_g: 3 }] }
    expect(alignProteinBatch(reply, 3)).toEqual([10, null, null])
  })

  test("returns all nulls for garbage", () => {
    expect(alignProteinBatch(null, 2)).toEqual([null, null])
    expect(alignProteinBatch({ items: "x" }, 2)).toEqual([null, null])
  })
})

// src/ai/parse.test.ts
import { describe, test, expect } from "bun:test"
import { coerceProtein, normalizeItems, stripFences, alignProteinBatch } from "./parse"

describe("coerceProtein", () => {
  test("rounds finite numbers to whole grams and clamps at zero", () => {
    expect(coerceProtein(14)).toBe(14)
    expect(coerceProtein(13.6)).toBe(14)
    expect(coerceProtein(0)).toBe(0)
    expect(coerceProtein(-3)).toBe(0)
  })

  test("accepts a numeric string", () => {
    expect(coerceProtein("22")).toBe(22)
    expect(coerceProtein(" 7.4 ")).toBe(7)
  })

  test("returns null for anything else", () => {
    expect(coerceProtein(undefined)).toBeNull()
    expect(coerceProtein(null)).toBeNull()
    expect(coerceProtein("lots")).toBeNull()
    expect(coerceProtein("")).toBeNull()
    expect(coerceProtein(Number.NaN)).toBeNull()
    expect(coerceProtein(Number.POSITIVE_INFINITY)).toBeNull()
    expect(coerceProtein({})).toBeNull()
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
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Rice", calories: 200, protein_g: null },
    ])
  })

  test("returns an empty array for a missing or non-array items field", () => {
    expect(normalizeItems(undefined)).toEqual([])
    expect(normalizeItems("nope")).toEqual([])
  })

  test("drops array elements that are not objects", () => {
    expect(normalizeItems([null, "x", 7, { description: "Rice", calories: 200, protein_g: 4 }])).toEqual([
      { description: "Rice", calories: 200, protein_g: 4 },
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

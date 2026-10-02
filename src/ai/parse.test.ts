// src/ai/parse.test.ts
import { describe, test, expect } from "bun:test"
import { coerceProtein, normalizeItems, stripFences } from "./parse"

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
})

describe("stripFences", () => {
  test("removes a ```json fence", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
  })

  test("leaves bare JSON alone", () => {
    expect(stripFences('  {"a":1} ')).toBe('{"a":1}')
  })
})

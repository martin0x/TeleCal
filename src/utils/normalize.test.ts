import { describe, test, expect } from "bun:test"
import { normalizeFoodText, foodWords, normalizeFoodName } from "./normalize"

describe("normalizeFoodText", () => {
  test("is the estimation_cache key it replaces, unchanged", () => {
    expect(normalizeFoodText("  Chicken   Adobo! ")).toBe("chicken adobo")
    // Spaces collapse before punctuation is stripped, so "&" leaves two spaces.
    expect(normalizeFoodText("2 eggs & toast")).toBe("2 eggs  toast")
  })
})

describe("foodWords / normalizeFoodName", () => {
  test("split on any whitespace and drop punctuation", () => {
    expect(foodWords("Mac & Cheese!")).toEqual(["mac", "cheese"])
    expect(normalizeFoodName("  Quaker   Oats! ")).toBe("quaker oats")
    expect(normalizeFoodName("!!!")).toBe("")
  })
})

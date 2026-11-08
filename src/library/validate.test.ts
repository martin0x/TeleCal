import { describe, test, expect } from "bun:test"
import { validateFood, DEFAULT_SERVING, MAX_FOOD_CALORIES, MAX_FOOD_GRAMS } from "./validate"

const ROW = {
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

function reason(input: Record<string, unknown>): string | null {
  const result = validateFood(input)
  return result.ok ? null : result.reason
}

function food(input: Record<string, unknown>) {
  const result = validateFood(input)
  if (!result.ok) throw new Error(result.reason)
  return result.food
}

describe("validateFood", () => {
  test("accepts a full label row as is", () => {
    expect(food(ROW)).toEqual(ROW)
  })

  test("tidies the name and requires one", () => {
    expect(food({ ...ROW, name: "  Quaker   Oats " }).name).toBe("Quaker Oats")
    expect(reason({ ...ROW, name: "" })).toBe("no name")
    expect(reason({ ...ROW, name: "!!!" })).toBe("no name")
    expect(reason({ ...ROW, name: 42 })).toBe("no name")
    expect(reason({ ...ROW, name: "x".repeat(101) })).toBe("name too long")
  })

  test("requires calories in range, rounding decimals and reading numeric strings", () => {
    expect(reason({ ...ROW, calories: undefined })).toBe("no calories")
    expect(reason({ ...ROW, calories: "n/a" })).toBe("no calories")
    expect(food({ ...ROW, calories: "150" }).calories).toBe(150)
    expect(food({ ...ROW, calories: 150.6 }).calories).toBe(151)
    expect(food({ ...ROW, calories: MAX_FOOD_CALORIES }).calories).toBe(5000)
    expect(reason({ ...ROW, calories: 5001 })).toBe("calories out of range")
    expect(reason({ ...ROW, calories: -1 })).toBe("calories out of range")
  })

  test("macros: blank means not on the label; one decimal place kept; range checked", () => {
    expect(food({ ...ROW, fat_g: 0.5 }).fat_g).toBe(0.5)
    expect(food({ ...ROW, fat_g: 0.55 }).fat_g).toBe(0.6)
    expect(food({ ...ROW, fiber_g: "" }).fiber_g).toBeNull()
    expect(food({ ...ROW, fiber_g: undefined }).fiber_g).toBeNull()
    expect(food({ ...ROW, fiber_g: "trace" }).fiber_g).toBeNull()
    expect(food({ ...ROW, protein_g: MAX_FOOD_GRAMS }).protein_g).toBe(500)
    expect(reason({ ...ROW, protein_g: 500.1 })).toBe("protein out of range")
    expect(reason({ ...ROW, added_sugar_g: -2 })).toBe("added sugar out of range")
  })

  test("a missing serving becomes 1 serving; a long one is cut to 100 characters", () => {
    expect(food({ ...ROW, serving: "" }).serving).toBe(DEFAULT_SERVING)
    expect(food({ ...ROW, serving: undefined }).serving).toBe(DEFAULT_SERVING)
    expect(food({ ...ROW, serving: "y".repeat(150) }).serving).toHaveLength(100)
  })

  test("a serving amount needs a positive number and a g or ml unit, else both are null", () => {
    expect(food({ ...ROW, serving_unit: "grams" })).toMatchObject({ serving_amount: 40, serving_unit: "g" })
    expect(food({ ...ROW, serving_amount: 250, serving_unit: "mL" })).toMatchObject({ serving_amount: 250, serving_unit: "ml" })
    expect(food({ ...ROW, serving_unit: null })).toMatchObject({ serving_amount: null, serving_unit: null })
    expect(food({ ...ROW, serving_unit: "cup" })).toMatchObject({ serving_amount: null, serving_unit: null })
    expect(food({ ...ROW, serving_amount: 0 })).toMatchObject({ serving_amount: null, serving_unit: null })
  })
})

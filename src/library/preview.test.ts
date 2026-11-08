import { describe, test, expect } from "bun:test"
import { formatFoodLine, formatPreview, importPreview, logPreview } from "./preview"
import type { FoodFields, SavedFood } from "./types"

const OATS_ROW = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
const SKY_ROW = { name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 3.5, fiber_g: null, added_sugar_g: 1 }

const SAVED_SKY: SavedFood = {
  ...(SKY_ROW as FoodFields),
  id: 3,
  telegram_id: 42,
  source: "import",
}

describe("importPreview", () => {
  test("keeps valid rows, marks replacements, and lists the rest as unreadable", () => {
    const preview = importPreview(
      {
        foods: [OATS_ROW, { ...SKY_ROW, name: "skyflakes" }, { name: "Lunch adobo", serving: "" }],
        unreadable: [{ text: "notes", reason: "not a food" }],
      },
      [SAVED_SKY]
    )
    expect(preview.rows.map((r) => [r.food.name, r.replaces])).toEqual([
      ["Quaker Oats", false],
      ["skyflakes", true],
    ])
    expect(preview.unreadable).toEqual([
      { text: "notes", reason: "not a food" },
      { text: "Lunch adobo", reason: "no calories" },
    ])
  })

  test("the same name twice: the later row wins", () => {
    const preview = importPreview({ foods: [SKY_ROW, { ...SKY_ROW, calories: 120 }], unreadable: [] }, [])
    expect(preview.rows.map((r) => r.food.calories)).toEqual([120])
  })
})

describe("logPreview", () => {
  const SAVED_OATS: SavedFood = { ...(OATS_ROW as FoodFields), id: 1, telegram_id: 42, source: "import" }

  test("turns logged items into foods served as logged, leaving out items from saved foods", () => {
    const preview = logPreview(
      [
        { description: "Chicken adobo (1 cup)", calories: 350, protein_g: 30, fat_g: 20, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" },
        { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 1 },
      ],
      [SAVED_OATS]
    )
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].food).toMatchObject({ name: "Chicken adobo (1 cup)", serving: "as logged", serving_amount: null, calories: 350 })
  })

  test("an item whose saved food has since been deleted is offered again", () => {
    const preview = logPreview([{ description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: 99 }], [SAVED_OATS])
    expect(preview.rows.map((r) => r.food.name)).toEqual(["Quaker Oats ×2"])
  })
})

describe("formatFoodLine / formatPreview", () => {
  test("a line shows every value the label has", () => {
    expect(formatFoodLine(OATS_ROW as FoodFields)).toBe("Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber")
    expect(formatFoodLine({ ...(SKY_ROW as FoodFields), serving: "1 serving" })).toBe(
      "Skyflakes · no serving size · 110 cal · 2g protein · 3.5g fat · 1g added sugar"
    )
  })

  test("header, numbered rows, replacements and unreadable rows", () => {
    const preview = importPreview(
      { foods: [OATS_ROW, SKY_ROW], unreadable: [{ text: "lunch adobo", reason: "no calories" }] },
      [SAVED_SKY]
    )
    expect(formatPreview("Found 2 foods (per serving):", preview)).toBe(
      "Found 2 foods (per serving):\n" +
        "1. Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber\n" +
        "2. Skyflakes · 1 pack (25 g) · 110 cal · 2g protein · 3.5g fat · 1g added sugar (replaces your saved one)\n" +
        'Couldn\'t read: "lunch adobo" (no calories)'
    )
  })

  test("a long preview fits one Telegram message and says how many rows it left out", () => {
    const foods = Array.from({ length: 120 }, (_, i) => ({ ...OATS_ROW, name: `Very long food name number ${i} with extra words` }))
    const text = formatPreview("Found 120 foods (per serving):", importPreview({ foods, unreadable: [] }, []))
    expect(text.length).toBeLessThanOrEqual(4096)
    const shown = text.split("\n").filter((line) => /^\d+\. /.test(line)).length
    expect(text).toEndWith(`…and ${120 - shown} more`)
  })

  test("caps long reasons so previews always fit one message", () => {
    const foods = Array.from({ length: 120 }, (_, i) => ({ ...OATS_ROW, name: `Very long food name number ${i} with extra words` }))
    const longReason = "x".repeat(2000)
    const unreadable = Array.from({ length: 5 }, (_, i) => ({ text: `Item ${i}`, reason: longReason }))
    const text = formatPreview("Found items:", importPreview({ foods, unreadable }, []))
    expect(text.length).toBeLessThanOrEqual(4096)
    const reasonMatches = text.match(/\([^)]+\)/g) || []
    for (const match of reasonMatches) {
      const reason = match.slice(1, -1)
      expect(reason.length).toBeLessThanOrEqual(40)
    }
  })
})

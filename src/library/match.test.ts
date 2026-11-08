import { describe, test, expect } from "bun:test"
import { candidatesFor, matchMeal, parseQuantity, scaleFood, splitMeal } from "./match"
import type { SavedFood } from "./types"

function food(overrides: Partial<SavedFood> & Pick<SavedFood, "id" | "name">): SavedFood {
  return {
    telegram_id: 42,
    source: "import",
    serving: "1 serving",
    serving_amount: null,
    serving_unit: null,
    calories: 100,
    protein_g: null,
    fat_g: null,
    fiber_g: null,
    added_sugar_g: null,
    ...overrides,
  }
}

const OATS = food({ id: 1, name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4 })
const MILK = food({ id: 2, name: "Nestle Fresh Milk", serving: "1 cup (250 ml)", serving_amount: 250, serving_unit: "ml", calories: 160, protein_g: 8, fat_g: 9, fiber_g: 0, added_sugar_g: 0 })
const SKYFLAKES = food({ id: 3, name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 0.5, added_sugar_g: 1 })
const MAC = food({ id: 4, name: "Mac and cheese", serving: "1 cup", calories: 380, protein_g: 14 })
const HALF_MOON = food({ id: 5, name: "Half Moon Cake", calories: 210 })
const LIBRARY = [OATS, MILK, SKYFLAKES, MAC, HALF_MOON]

/** [food id, servings] per matched item, or null. */
function match(text: string, foods = LIBRARY) {
  const items = matchMeal(text, foods)
  return items && items.map((i) => [i.food.id, i.servings])
}

describe("matchMeal: code-only path", () => {
  test.each([
    ["quaker oats", [[1, 1]]],
    ["Quaker Oats!", [[1, 1]]],
    ["oats", [[1, 1]]],
    ["2 oats", [[1, 2]]],
    ["2x oats", [[1, 2]]],
    ["oats x2", [[1, 2]]],
    ["oats ×2", [[1, 2]]],
    ["1/2 oats", [[1, 0.5]]],
    ["0.5 oats", [[1, 0.5]]],
    ["half oats", [[1, 0.5]]],
    ["2 servings oats", [[1, 2]]],
    ["2 servings of oats", [[1, 2]]],
    ["a skyflakes", [[3, 1]]],
    ["80g oats", [[1, 2]]],
    ["80 g oats", [[1, 2]]],
    ["80 grams of oats", [[1, 2]]],
    ["oats 80g", [[1, 2]]],
    ["250ml fresh milk", [[2, 1]]],
    ["500 ml milk", [[2, 2]]],
    ["2 skyflakes, 250ml fresh milk", [[3, 2], [2, 1]]],
    ["oats and milk", [[1, 1], [2, 1]]],
    ["oats + milk", [[1, 1], [2, 1]]],
    ["oats & milk", [[1, 1], [2, 1]]],
    ["oats\nmilk", [[1, 1], [2, 1]]],
    ["mac and cheese", [[4, 1]]],
    ["half moon cake", [[5, 1]]],
  ] as const)("%p", (text, expected) => {
    expect(match(text)).toEqual(expected as unknown as number[][])
  })

  test.each([
    "oats and a banana", // banana is not saved
    "a bowl of oats", // "bowl" can't be scaled
    "100ml oats", // unit mismatch: oats are weighed
    "100g mac and cheese", // no serving amount to scale by
    "2 cups mac and cheese",
    "0 oats",
    "rice",
  ])("%p goes to the AI", (text) => {
    expect(matchMeal(text, LIBRARY)).toBeNull()
  })

  test("two foods containing every typed word is ambiguous, but an exact name still wins", () => {
    const library = [...LIBRARY, food({ id: 6, name: "Quaker Oats Instant" })]
    expect(matchMeal("oats", library)).toBeNull()
    expect(match("quaker oats", library)).toEqual([[1, 1]])
  })

  test("an empty library matches nothing", () => {
    expect(matchMeal("oats", [])).toBeNull()
  })
})

describe("parseQuantity / splitMeal", () => {
  test("no quantity means one serving of the whole text", () => {
    expect(parseQuantity("Quaker Oats")).toEqual({ quantity: { kind: "servings", n: 1 }, rest: "quaker oats" })
  })

  test("an unusable quantity is null", () => {
    expect(parseQuantity("0 oats")).toBeNull()
    expect(parseQuantity("1/0 oats")).toBeNull()
  })

  test("splits on commas, plus, ampersand, 'and' and new lines, not inside words", () => {
    expect(splitMeal("2 skyflakes, milk + oats & rice and beans\nsandwich")).toEqual([
      "2 skyflakes",
      "milk",
      "oats",
      "rice",
      "beans",
      "sandwich",
    ])
  })
})

describe("scaleFood", () => {
  test("multiplies label values and rounds; blanks stay null", () => {
    expect(scaleFood(OATS, 2)).toEqual({
      description: "Quaker Oats ×2",
      calories: 300,
      protein_g: 10,
      fat_g: 6,
      fiber_g: 8,
      added_sugar_g: null,
      saved_food_id: 1,
    })
  })

  test("one serving keeps the plain name; 3 × 0.5 g fat logs as 2 g", () => {
    expect(scaleFood(SKYFLAKES, 1).description).toBe("Skyflakes")
    expect(scaleFood(SKYFLAKES, 3).fat_g).toBe(2)
    expect(scaleFood(SKYFLAKES, 1 / 3).description).toBe("Skyflakes ×0.33")
  })
})

describe("candidatesFor", () => {
  test("picks saved foods sharing a meaningful word", () => {
    expect(candidatesFor("80g oats and a banana", LIBRARY).map((f) => f.id)).toEqual([1])
    expect(candidatesFor("rice", LIBRARY)).toEqual([])
    expect(candidatesFor("2 servings of", LIBRARY)).toEqual([])
  })

  test("ranks by shared words, then shorter names", () => {
    const tea = food({ id: 7, name: "Milk Tea" })
    expect(candidatesFor("fresh milk", [tea, MILK]).map((f) => f.id)).toEqual([2, 7])
  })

  test("caps at 15", () => {
    const many = Array.from({ length: 20 }, (_, i) => food({ id: 100 + i, name: `Chicken ${i}` }))
    expect(candidatesFor("chicken", many)).toHaveLength(15)
  })
})

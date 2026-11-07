import { describe, test, expect } from "bun:test"
import {
  MACROS,
  DEFAULT_MACROS,
  isMacroKey,
  getMacro,
  parseTrackedMacros,
  serializeTrackedMacros,
  macroByKeyword,
  withMacro,
  zeroTotals,
  addTotals,
  averageTotals,
  emptyMacroValues,
  macroValuesOf,
} from "./macros"

const ALL = MACROS.map((m) => m.key)

describe("registry", () => {
  test("protein comes first, with its bare item unit", () => {
    expect(MACROS[0]).toMatchObject({ key: "protein", column: "protein_g", itemLabel: "", totalLabel: "protein" })
  })

  test("keys and columns are unique, and every rule names its column", () => {
    expect(new Set(ALL).size).toBe(MACROS.length)
    expect(new Set(MACROS.map((m) => m.column)).size).toBe(MACROS.length)
    for (const m of MACROS) expect(m.rule).toStartWith(`- ${m.column}: `)
  })

  test("the default is protein only", () => {
    expect(DEFAULT_MACROS).toEqual(["protein"])
  })
})

describe("isMacroKey / getMacro", () => {
  test("know registry keys only", () => {
    expect(isMacroKey("protein")).toBe(true)
    expect(isMacroKey("carbs")).toBe(false)
    expect(getMacro("protein").name).toBe("Protein")
  })
})

describe("parseTrackedMacros", () => {
  test("null or undefined means the default", () => {
    expect(parseTrackedMacros(null)).toEqual(["protein"])
    expect(parseTrackedMacros(undefined)).toEqual(["protein"])
  })

  test("an empty string means none", () => {
    expect(parseTrackedMacros("")).toEqual([])
  })

  test("drops unknown keys and tolerates spaces", () => {
    expect(parseTrackedMacros(" protein , carbs")).toEqual(["protein"])
  })

  test("returns registry order whatever the stored order", () => {
    expect(parseTrackedMacros([...ALL].reverse().join(","))).toEqual(ALL)
  })
})

describe("serializeTrackedMacros", () => {
  test("round-trips through parseTrackedMacros, including none", () => {
    expect(parseTrackedMacros(serializeTrackedMacros(ALL))).toEqual(ALL)
    expect(serializeTrackedMacros([])).toBe("")
    expect(parseTrackedMacros(serializeTrackedMacros([]))).toEqual([])
  })
})

describe("macroByKeyword", () => {
  test("ignores case and extra spaces", () => {
    expect(macroByKeyword(" PROTEIN ")?.key).toBe("protein")
  })

  test("is undefined for anything else", () => {
    expect(macroByKeyword("carbs")).toBeUndefined()
    expect(macroByKeyword("")).toBeUndefined()
  })
})

describe("withMacro", () => {
  test("adds a key once, in registry order", () => {
    expect(withMacro([], "protein")).toEqual(["protein"])
    expect(withMacro(["protein"], "protein")).toEqual(["protein"])
  })
})

describe("totals helpers", () => {
  test("zeroTotals has calories and one zero per macro", () => {
    const zero = zeroTotals()
    expect(Object.keys(zero).sort()).toEqual(["calories", ...ALL].sort())
    expect(Object.values(zero).every((v) => v === 0)).toBe(true)
  })

  test("addTotals adds key by key; averageTotals divides and rounds", () => {
    const a = { ...zeroTotals(), calories: 100, protein: 10 }
    const b = { ...zeroTotals(), calories: 51, protein: 5 }
    expect(addTotals(a, b)).toEqual({ ...zeroTotals(), calories: 151, protein: 15 })
    expect(averageTotals({ ...zeroTotals(), calories: 1000, protein: 75 }, 3)).toEqual({
      ...zeroTotals(),
      calories: 333,
      protein: 25,
    })
  })
})

describe("macro values", () => {
  test("emptyMacroValues is null for every column", () => {
    expect(Object.keys(emptyMacroValues()).sort()).toEqual(MACROS.map((m) => m.column).sort())
    expect(Object.values(emptyMacroValues()).every((v) => v === null)).toBe(true)
  })

  test("macroValuesOf keeps known values and nulls the rest", () => {
    expect(macroValuesOf({ protein_g: 12 })).toEqual({ ...emptyMacroValues(), protein_g: 12 })
    expect(macroValuesOf({})).toEqual(emptyMacroValues())
  })
})

describe("fat, fiber and added sugar", () => {
  test("follow protein in this order", () => {
    expect(MACROS.map((m) => m.key)).toEqual(["protein", "fat", "fiber", "added_sugar"])
    expect(MACROS.map((m) => m.column)).toEqual(["protein_g", "fat_g", "fiber_g", "added_sugar_g"])
  })

  test("carry the spec's labels", () => {
    expect(MACROS.map((m) => [m.name, m.itemLabel, m.totalLabel])).toEqual([
      ["Protein", "", "protein"],
      ["Fat", "fat", "fat"],
      ["Fiber", "fiber", "fiber"],
      ["Added sugar", "sugar", "added sugar"],
    ])
  })

  test("are found by their /edit words", () => {
    expect(macroByKeyword("fat")?.key).toBe("fat")
    expect(macroByKeyword("Fibre")?.key).toBe("fiber")
    expect(macroByKeyword("sugar")?.key).toBe("added_sugar")
    expect(macroByKeyword("added  sugar")?.key).toBe("added_sugar")
  })

  test("the added sugar rule says what counts", () => {
    const rule = getMacro("added_sugar").rule
    expect(rule).toContain("added in processing or cooking")
    expect(rule).toContain("whole fruit, vegetables and plain milk counts as 0")
  })

  test("parsing and withMacro keep registry order", () => {
    expect(parseTrackedMacros("added_sugar,protein")).toEqual(["protein", "added_sugar"])
    expect(withMacro(["added_sugar"], "fat")).toEqual(["fat", "added_sugar"])
  })
})

// src/macros.ts
// The one place that names a macro. Calories are not in here: they are
// always tracked and always shown. Prompts, parsing, the cache check,
// repository SQL, formatting, /edit, /settings and the web API all loop over
// MACROS, so a new macro is an entry here plus its column. See
// docs/superpowers/specs/2026-11-08-macro-tracking-design.md.

export const MACROS = [
  {
    key: "protein",
    column: "protein_g",
    /** /settings, /today and reminders. */
    name: "Protein",
    /** After the grams on an item line. Protein's is empty: its bare "g" predates the other macros. */
    itemLabel: "",
    /** After the grams in a total. */
    totalLabel: "protein",
    /** Words that may follow "Ng" in /edit. */
    keywords: ["protein"],
    /** The prompt line asking the model for this value. */
    rule: "- protein_g: estimated grams of protein for the item, as a whole number",
  },
  {
    key: "fat",
    column: "fat_g",
    name: "Fat",
    itemLabel: "fat",
    totalLabel: "fat",
    keywords: ["fat"],
    rule: "- fat_g: estimated grams of total fat for the item, as a whole number",
  },
  {
    key: "fiber",
    column: "fiber_g",
    name: "Fiber",
    itemLabel: "fiber",
    totalLabel: "fiber",
    keywords: ["fiber", "fibre"],
    rule: "- fiber_g: estimated grams of dietary fiber for the item, as a whole number",
  },
  {
    key: "added_sugar",
    column: "added_sugar_g",
    name: "Added sugar",
    // "sugar" on item lines to save width; totals spell out "added sugar".
    itemLabel: "sugar",
    totalLabel: "added sugar",
    keywords: ["sugar", "added sugar"],
    rule:
      "- added_sugar_g: estimated grams of added sugar for the item, as a whole number. " +
      "Count sugar, syrups, honey and other sweeteners added in processing or cooking, including in sauces, drinks and desserts. " +
      "Sugar that occurs naturally in whole fruit, vegetables and plain milk counts as 0",
  },
] as const

export type Macro = (typeof MACROS)[number]
export type MacroKey = Macro["key"]
export type MacroColumn = Macro["column"]
/** A meal's or a day's calories plus every macro, unknown values counted as 0. */
export type Totals = { calories: number } & Record<MacroKey, number>
/** One item's macros by column. null = unknown. */
export type MacroValues = Record<MacroColumn, number | null>

/** What a user tracks until they change it in /settings → Macros. */
export const DEFAULT_MACROS: readonly MacroKey[] = ["protein"]

/** Above this a value is garbage, not food: the AI's is dropped and /edit refuses it. */
export const MAX_GRAMS = 1000

const KEYS: ReadonlySet<string> = new Set(MACROS.map((m) => m.key))

export function isMacroKey(value: string): value is MacroKey {
  return KEYS.has(value)
}

export function getMacro(key: MacroKey): Macro {
  return MACROS.find((m) => m.key === key)!
}

/** users.tracked_macros → keys in registry order. Unknown keys are dropped; null means the default; "" means none. */
export function parseTrackedMacros(raw: string | null | undefined): MacroKey[] {
  if (raw === null || raw === undefined) return [...DEFAULT_MACROS]
  const wanted = new Set(raw.split(",").map((part) => part.trim()))
  return MACROS.filter((m) => wanted.has(m.key)).map((m) => m.key)
}

export function serializeTrackedMacros(keys: readonly MacroKey[]): string {
  return MACROS.filter((m) => keys.includes(m.key))
    .map((m) => m.key)
    .join(",")
}

/** "Added  Sugar" → added sugar. Case and extra spaces don't matter. */
export function macroByKeyword(word: string): Macro | undefined {
  const wanted = word.trim().toLowerCase().replace(/\s+/g, " ")
  return MACROS.find((m) => (m.keywords as readonly string[]).includes(wanted))
}

/** keys plus key, in registry order. */
export function withMacro(keys: readonly MacroKey[], key: MacroKey): MacroKey[] {
  return MACROS.filter((m) => m.key === key || keys.includes(m.key)).map((m) => m.key)
}

export function zeroTotals(): Totals {
  return { calories: 0, ...Object.fromEntries(MACROS.map((m) => [m.key, 0])) } as Totals
}

export function addTotals(a: Totals, b: Totals): Totals {
  const out = { ...a, calories: a.calories + b.calories }
  for (const m of MACROS) out[m.key] = a[m.key] + b[m.key]
  return out
}

/** Each value divided by days, rounded. */
export function averageTotals(totals: Totals, days: number): Totals {
  const out = { ...totals, calories: Math.round(totals.calories / days) }
  for (const m of MACROS) out[m.key] = Math.round(totals[m.key] / days)
  return out
}

export function emptyMacroValues(): MacroValues {
  return Object.fromEntries(MACROS.map((m) => [m.column, null])) as MacroValues
}

/** Every macro column of an item; missing ones become null. */
export function macroValuesOf(item: Partial<MacroValues>): MacroValues {
  return Object.fromEntries(MACROS.map((m) => [m.column, item[m.column] ?? null])) as MacroValues
}

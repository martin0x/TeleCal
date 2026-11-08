// src/ai/prompt.ts
// Prompt text shared across providers. Anthropic and Gemini ask for JSON in
// prose; OpenAI's strict schema carries the shape, so it keeps its own shorter
// instructions and shares only MACRO_RULES. A macro added to src/macros.ts
// joins MACRO_RULES by itself, but the shape lines and worked examples below
// are prose and are updated by hand (prompt.test.ts fails until they are).
import { MACROS } from "../macros"
import type { SavedFood } from "../library/types"

/** One rule line per macro, in registry order. Both estimate prompts end their rules with it. */
export const MACRO_RULES = MACROS.map((m) => m.rule).join("\n")

export const ESTIMATE_JSON_PROMPT = `You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food.

When given a food description, respond with ONLY a JSON object (no markdown, no explanation) containing:
- items: array of {description, calories, protein_g, fat_g, fiber_g, added_sugar_g, emoji} for each food item
- needsClarification: boolean - true if the description is too vague
- clarificationQuestion: string - question to ask if clarification needed
- confidence: "high" | "medium" | "low"

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include relevant emoji for each food item
- If multiple items mentioned, break them down separately
- If quantity/size is unclear, ask for clarification
${MACRO_RULES}

Example input: "chicken sandwich and fries"
Example output:
{"items":[{"description":"Chicken sandwich","calories":450,"protein_g":28,"fat_g":18,"fiber_g":2,"added_sugar_g":4,"emoji":"🥪"},{"description":"French fries (medium)","calories":365,"protein_g":4,"fat_g":17,"fiber_g":4,"added_sugar_g":0,"emoji":"🍟"}],"needsClarification":false,"confidence":"medium"}`

export const MACRO_BATCH_PROMPT = `You are a nutrition expert. You will receive a numbered list of food descriptions, one per line, in the form "1. <description>".

For each line, estimate the grams of protein, total fat, dietary fiber and added sugar, using common portion sizes when none is given.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"items":[{"index":1,"protein_g":14,"fat_g":10,"fiber_g":0,"added_sugar_g":0},{"index":2,"protein_g":0,"fat_g":0,"fiber_g":0,"added_sugar_g":0}]}

Rules:
- Return exactly one entry per input line, using that line's number as index
${MACRO_RULES}
- Never skip a line; if unsure, give your best estimate`

/** "1. Chicken adobo\n2. Rice" — newlines inside a description are collapsed so lines stay lines. */
export function formatBatchInput(descriptions: string[]): string {
  return descriptions.map((d, i) => `${i + 1}. ${d.replace(/\s+/g, " ").trim()}`).join("\n")
}

/** The user message for an estimate: the food, with clarification context before it and saved foods after. */
export function estimateUserMessage(foodDescription: string, context?: string, savedFoods?: string): string {
  const base = context
    ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
    : foodDescription
  return savedFoods ? `${base}\n\n${savedFoods}` : base
}

export const SAVED_FOODS_HEADER = "Saved foods (the user's own label values, per serving):"

function labelValue(value: number | null, name: string): string {
  return value === null ? `${name} not on label` : `${name} ${value} g`
}

/**
 * The saved-foods block. It goes in the user message, never the system
 * prompt, so the system prompt stays identical across users (provider prompt
 * caching) and calls without saved foods stay byte-identical. It carries its
 * own instructions for the two extra fields.
 */
export function formatSavedFoods(foods: SavedFood[]): string {
  const lines = foods.map(
    (f) =>
      `[${f.id}] ${f.name}, serving ${f.serving}: ${f.calories} kcal, ` +
      MACROS.map((m) => labelValue(f[m.column], m.totalLabel)).join(", ")
  )
  return [
    SAVED_FOODS_HEADER,
    ...lines,
    "",
    "Add two fields to every item. If the item is one of these saved foods: saved_food_id is its number in brackets, " +
      "and servings is how many servings were eaten (convert the amount eaten using the serving size; 1 when no amount is given). " +
      "Otherwise both are null. Still give your own estimate for every other field.",
  ].join("\n")
}

/**
 * Output limit for parseFoods. A full 4096-character paste of short rows is
 * about 80 rows, over 4,000 output tokens, and a cut-off reply is bad JSON.
 * Billing is per token produced, not per limit.
 */
export const FOODS_MAX_TOKENS = 16384

export const FOODS_PARSE_PROMPT = `You turn pasted nutrition information into structured rows. The text may be a table copied from a document or spreadsheet, a list, or one food typed by hand.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"foods":[{"name":"Quaker Oats","serving":"1/2 cup (40 g)","serving_amount":40,"serving_unit":"g","calories":150,"protein_g":5,"fat_g":3,"fiber_g":4,"added_sugar_g":null}],"unreadable":[{"text":"lunch adobo","reason":"no calories"}]}

Rules:
- One entry in foods per food. All values are per serving.
- If a row gives both per serving and per 100 g values, use per serving. If it gives only per 100 g values, set serving to "100 g", serving_amount to 100 and serving_unit to "g".
- serving: the serving size as written, e.g. "1 cup (250 ml)". Empty string if none is given.
- serving_amount and serving_unit: the serving's weight in grams ("g") or volume in millilitres ("ml") when it is written; otherwise null.
- calories: kcal per serving. Convert kJ by dividing by 4.184.
- protein_g, fat_g, fiber_g, added_sugar_g: grams per serving as written, decimals allowed; null when not given.
- added_sugar_g only from an "added sugar" value; total sugars do not count, so leave it null when only total sugars are given.
- Never estimate a value that is not in the text.
- A row with no calories goes in unreadable with reason "no calories". Text that is not a food (headings, notes, blank lines) is ignored.`

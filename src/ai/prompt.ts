// src/ai/prompt.ts
// Prompt text shared across providers. Anthropic and Gemini ask for JSON in
// prose and previously carried byte-identical copies of this text in two
// files; OpenAI's strict schema carries the shape, so it keeps its own shorter
// instructions and shares only the protein rule.

export const PROTEIN_RULE = "- protein_g: estimated grams of protein for the item, as a whole number"

export const ESTIMATE_JSON_PROMPT = `You are a nutrition expert that estimates calories and protein in food.

When given a food description, respond with ONLY a JSON object (no markdown, no explanation) containing:
- items: array of {description, calories, protein_g, emoji} for each food item
- needsClarification: boolean - true if the description is too vague
- clarificationQuestion: string - question to ask if clarification needed
- confidence: "high" | "medium" | "low"

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include relevant emoji for each food item
- If multiple items mentioned, break them down separately
- If quantity/size is unclear, ask for clarification
${PROTEIN_RULE}

Example input: "chicken sandwich and fries"
Example output:
{"items":[{"description":"Chicken sandwich","calories":450,"protein_g":28,"emoji":"🥪"},{"description":"French fries (medium)","calories":365,"protein_g":4,"emoji":"🍟"}],"needsClarification":false,"confidence":"medium"}`

export const PROTEIN_BATCH_PROMPT = `You are a nutrition expert. You will receive a numbered list of food descriptions, one per line, in the form "1. <description>".

For each line, estimate the grams of protein, using common portion sizes when none is given.

Respond with ONLY a JSON object (no markdown, no explanation) of the form:
{"items":[{"index":1,"protein_g":14},{"index":2,"protein_g":0}]}

Rules:
- Return exactly one entry per input line, using that line's number as index
- protein_g is a whole number of grams
- Never skip a line; if unsure, give your best estimate`

/** "1. Chicken adobo\n2. Rice" — newlines inside a description are collapsed so lines stay lines. */
export function formatProteinBatchInput(descriptions: string[]): string {
  return descriptions.map((d, i) => `${i + 1}. ${d.replace(/\s+/g, " ").trim()}`).join("\n")
}

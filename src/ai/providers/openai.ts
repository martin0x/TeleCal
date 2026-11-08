// src/ai/providers/openai.ts
import OpenAI from "openai"
import { AIProvider, ProviderResult, MacroBatchResult, TokenUsage, type FoodsParseResult } from "../types"
import { config } from "../../config"
import { MACRO_RULES, MACRO_BATCH_PROMPT, FOODS_PARSE_PROMPT, FOODS_MAX_TOKENS, formatBatchInput, estimateUserMessage } from "../prompt"
import { normalizeItems, alignMacroBatch, parseReply, traceOf, normalizeFoodsReply } from "../parse"
import { MACROS } from "../../macros"

const INSTRUCTIONS = `You are a nutrition expert that estimates calories, protein, fat, fiber and added sugar in food.

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include a relevant emoji for each food item
- If multiple items are mentioned, break them down separately
- If quantity or size is unclear, set needsClarification to true and ask a
  specific question in clarificationQuestion
- When no clarification is needed, return an empty string for
  clarificationQuestion
${MACRO_RULES}`

/** `{ protein_g: { type: "number" }, … }` and the column list, for the strict schemas. */
const MACRO_PROPERTIES = Object.fromEntries(MACROS.map((m) => [m.column, { type: "number" }]))
const MACRO_COLUMNS = MACROS.map((m) => m.column)

const ESTIMATE_ITEM_PROPERTIES = {
  description: { type: "string" },
  calories: { type: "number" },
  ...MACRO_PROPERTIES,
  emoji: { type: "string" },
}
const ESTIMATE_ITEM_REQUIRED = ["description", "calories", ...MACRO_COLUMNS, "emoji"]

function estimateSchema(itemProperties: Record<string, unknown>, itemRequired: string[]) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: itemProperties, required: itemRequired, additionalProperties: false },
      },
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["items", "needsClarification", "clarificationQuestion", "confidence"],
    additionalProperties: false,
  }
}

/**
 * Strict Structured Outputs requires every property to appear in `required`
 * and `additionalProperties: false` on every object. Fields that are
 * conceptually optional (clarificationQuestion, emoji) are therefore required
 * here and filled with an empty string when not applicable — see INSTRUCTIONS.
 */
const ESTIMATE_SCHEMA = estimateSchema(ESTIMATE_ITEM_PROPERTIES, ESTIMATE_ITEM_REQUIRED)

/** With saved foods in the message: the same, plus saved_food_id and servings, nullable so strict mode allows null. */
const ESTIMATE_WITH_SAVED_SCHEMA = estimateSchema(
  {
    ...ESTIMATE_ITEM_PROPERTIES,
    saved_food_id: { type: ["integer", "null"] },
    servings: { type: ["number", "null"] },
  },
  [...ESTIMATE_ITEM_REQUIRED, "saved_food_id", "servings"]
)

const MACRO_BATCH_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          ...MACRO_PROPERTIES,
        },
        required: ["index", ...MACRO_COLUMNS],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const

const NULLABLE_NUMBER = { type: ["number", "null"] }

/** Strict: every field required; nullable where a label may leave it out. serving_unit is checked by validateFood. */
const FOODS_SCHEMA = {
  type: "object",
  properties: {
    foods: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          serving: { type: "string" },
          serving_amount: NULLABLE_NUMBER,
          serving_unit: { type: ["string", "null"] },
          calories: { type: "number" },
          ...Object.fromEntries(MACROS.map((m) => [m.column, NULLABLE_NUMBER])),
        },
        required: ["name", "serving", "serving_amount", "serving_unit", "calories", ...MACRO_COLUMNS],
        additionalProperties: false,
      },
    },
    unreadable: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, reason: { type: "string" } },
        required: ["text", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["foods", "unreadable"],
  additionalProperties: false,
}

const MODEL = "gpt-5.6-luna"

/** The subset of a Responses API result that usage accounting reads. */
interface ResponsesUsageSource {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

function usageFrom(response: ResponsesUsageSource): TokenUsage {
  return {
    model: response.model ?? MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

export class OpenAIProvider implements AIProvider {
  name = "openai"
  private client: OpenAI

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  async estimate(foodDescription: string, context?: string, savedFoods?: string): Promise<ProviderResult> {
    const userMessage = estimateUserMessage(foodDescription, context, savedFoods)

    const response = await this.client.responses.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: userMessage,
      reasoning: { effort: "none" },
      // Defaults to true, which would retain user food descriptions in the
      // OpenAI org for 30+ days. TeleCal keeps its own conversation state.
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "calorie_estimate",
          schema: savedFoods ? ESTIMATE_WITH_SAVED_SCHEMA : ESTIMATE_SCHEMA,
          strict: true,
        },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    // No markdown-fence stripping: strict Structured Outputs cannot return
    // fenced or malformed JSON.
    const usage = usageFrom(response)
    const trace = traceOf(INSTRUCTIONS, userMessage, content)
    const result = parseReply(content, usage, trace) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(result.items),
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion || undefined,
        confidence: result.confidence || "medium",
      },
      usage,
      trace,
    }
  }

  async estimateMacros(descriptions: string[]): Promise<MacroBatchResult> {
    const userMessage = formatBatchInput(descriptions)
    const response = await this.client.responses.create({
      model: MODEL,
      instructions: MACRO_BATCH_PROMPT,
      input: userMessage,
      reasoning: { effort: "none" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "macro_batch",
          schema: MACRO_BATCH_SCHEMA,
          strict: true,
        },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    const usage = usageFrom(response)
    const trace = traceOf(MACRO_BATCH_PROMPT, userMessage, content)
    return {
      values: alignMacroBatch(parseReply(content, usage, trace), descriptions.length),
      usage,
      trace,
    }
  }

  async parseFoods(text: string): Promise<FoodsParseResult> {
    const response = await this.client.responses.create({
      model: MODEL,
      instructions: FOODS_PARSE_PROMPT,
      input: text,
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: FOODS_MAX_TOKENS,
      text: {
        format: { type: "json_schema", name: "foods", schema: FOODS_SCHEMA, strict: true },
      },
    })

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    const usage = usageFrom(response)
    const trace = traceOf(FOODS_PARSE_PROMPT, text, content)
    return { reply: normalizeFoodsReply(parseReply(content, usage, trace)), usage, trace }
  }
}

// src/ai/providers/openai.ts
import OpenAI from "openai"
import { AIProvider, ProviderResult, FoodEstimate } from "../types"
import { config } from "../../config"

const INSTRUCTIONS = `You are a nutrition expert that estimates calories in food.

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include a relevant emoji for each food item
- If multiple items are mentioned, break them down separately
- If quantity or size is unclear, set needsClarification to true and ask a
  specific question in clarificationQuestion
- When no clarification is needed, return an empty string for
  clarificationQuestion`

/**
 * Strict Structured Outputs requires every property to appear in `required`
 * and `additionalProperties: false` on every object. Fields that are
 * conceptually optional (clarificationQuestion, emoji) are therefore required
 * here and filled with an empty string when not applicable — see INSTRUCTIONS.
 */
const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          calories: { type: "number" },
          emoji: { type: "string" },
        },
        required: ["description", "calories", "emoji"],
        additionalProperties: false,
      },
    },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["items", "needsClarification", "clarificationQuestion", "confidence"],
  additionalProperties: false,
} as const

export class OpenAIProvider implements AIProvider {
  name = "openai"
  private client: OpenAI

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.responses.create({
      model: "gpt-5.6-luna",
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
          schema: ESTIMATE_SCHEMA,
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
    const result = JSON.parse(content) as {
      items: FoodEstimate[]
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: result.items || [],
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion || undefined,
        confidence: result.confidence || "medium",
      },
      usage: {
        model: response.model ?? "gpt-5.6-luna",
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
    }
  }
}

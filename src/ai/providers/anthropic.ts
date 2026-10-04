// src/ai/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk"
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, stripFences, alignProteinBatch } from "../parse"

const MODEL = "claude-haiku-4-5-20251001"

interface AnthropicUsageSource {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }
}

function usageFrom(response: AnthropicUsageSource): TokenUsage {
  return {
    model: response.model ?? MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    cachedInputTokens: response.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }
}

/** The first content block as text, or throws — the shape every call here expects. */
function firstText(response: { content: { type: string; text?: string }[] }): string {
  const block = response.content[0]
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("Unexpected response type from Anthropic")
  }
  return block.text
}

export class AnthropicProvider implements AIProvider {
  name = "anthropic"
  private client: Anthropic

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: config.ai.anthropicApiKey })
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: ESTIMATE_JSON_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })

    const result = JSON.parse(stripFences(firstText(response))) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(result.items),
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion,
        confidence: result.confidence || "medium",
      },
      usage: usageFrom(response),
    }
  }

  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: PROTEIN_BATCH_PROMPT,
      messages: [{ role: "user", content: formatProteinBatchInput(descriptions) }],
    })

    return {
      protein: alignProteinBatch(JSON.parse(stripFences(firstText(response))), descriptions.length),
      usage: usageFrom(response),
    }
  }
}

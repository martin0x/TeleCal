// src/ai/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk"
import { AIProvider, ProviderResult } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT } from "../prompt"
import { normalizeItems, stripFences } from "../parse"

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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: ESTIMATE_JSON_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })

    const content = response.content[0]
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Anthropic")
    }

    const result = JSON.parse(stripFences(content.text)) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    const usage = response.usage as {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }

    return {
      estimate: {
        items: normalizeItems(result.items),
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion,
        confidence: result.confidence || "medium",
      },
      usage: {
        model: response.model ?? "claude-haiku-4-5-20251001",
        inputTokens: usage?.input_tokens ?? 0,
        cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
    }
  }
}

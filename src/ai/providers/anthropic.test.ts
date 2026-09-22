// src/ai/providers/anthropic.test.ts
import { describe, test, expect } from "bun:test"
import Anthropic from "@anthropic-ai/sdk"
import { AnthropicProvider } from "./anthropic"

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  confidence: "high",
})

function fakeClient(text: string, usage?: Record<string, number>) {
  return {
    messages: {
      create: async () => ({
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text }],
        usage: usage ?? { input_tokens: 200, output_tokens: 60 },
      }),
    },
  } as unknown as Anthropic
}

describe("AnthropicProvider", () => {
  test("reports tokens from the usage block", async () => {
    const result = await new AnthropicProvider(fakeClient(VALID_REPLY)).estimate("two eggs")

    expect(result.usage.model).toBe("claude-haiku-4-5-20251001")
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(60)
    expect(result.estimate.items).toHaveLength(1)
  })

  test("reports cache read tokens when present", async () => {
    const client = fakeClient(VALID_REPLY, {
      input_tokens: 200,
      output_tokens: 60,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 20,
    })
    const result = await new AnthropicProvider(client).estimate("two eggs")

    expect(result.usage.cachedInputTokens).toBe(150)
    expect(result.usage.cacheWriteTokens).toBe(20)
  })

  test("still strips markdown fences", async () => {
    const fenced = "```json\n" + VALID_REPLY + "\n```"
    const result = await new AnthropicProvider(fakeClient(fenced)).estimate("two eggs")

    expect(result.estimate.items[0].calories).toBe(180)
  })
})

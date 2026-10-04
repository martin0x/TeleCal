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

  test("surfaces protein_g and nulls a missing one", async () => {
    const reply = JSON.stringify({
      items: [
        { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
        { description: "Toast", calories: 120, emoji: "🍞" },
      ],
      needsClarification: false,
      confidence: "high",
    })
    const result = await new AnthropicProvider(fakeClient(reply)).estimate("eggs and toast")
    expect(result.estimate.items.map((i) => i.protein_g)).toEqual([12, null])
  })

  test("asks for protein_g in the system prompt", async () => {
    const calls: any[] = []
    const client = {
      messages: {
        create: async (args: any) => {
          calls.push(args)
          return { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: VALID_REPLY }], usage: { input_tokens: 1, output_tokens: 1 } }
        },
      },
    } as unknown as Anthropic
    await new AnthropicProvider(client).estimate("two eggs")
    expect(calls[0].system).toContain("protein_g")
  })
})

describe("AnthropicProvider.estimateProtein", () => {
  test("sends the batch prompt and aligns the reply", async () => {
    const calls: any[] = []
    const client = {
      messages: {
        create: async (args: any) => {
          calls.push(args)
          return {
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "text", text: "```json\n" + JSON.stringify({ items: [{ index: 1, protein_g: 38 }] }) + "\n```" }],
            usage: { input_tokens: 90, output_tokens: 12 },
          }
        },
      },
    } as unknown as Anthropic
    const result = await new AnthropicProvider(client).estimateProtein(["Chicken adobo", "Rice"])

    expect(calls[0].system).toContain("numbered list")
    expect(calls[0].messages[0].content).toBe("1. Chicken adobo\n2. Rice")
    expect(result.protein).toEqual([38, null])
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 12 })
  })
})

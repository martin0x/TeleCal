// src/ai/providers/openai.test.ts
import { describe, test, expect } from "bun:test"
import OpenAI from "openai"
import { OpenAIProvider } from "./openai"

/** Captures the arguments a Responses call was made with, and returns a canned reply. */
function fakeClient(outputText: string) {
  const calls: any[] = []
  const client = {
    responses: {
      create: async (args: any) => {
        calls.push(args)
        return {
          model: "gpt-5.6-luna",
          output_text: outputText,
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 45,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 165,
          },
        }
      },
    },
  }
  return { client: client as unknown as OpenAI, calls }
}

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  clarificationQuestion: "",
  confidence: "high",
})

describe("OpenAIProvider", () => {
  test("parses a structured estimate", async () => {
    const { client } = fakeClient(VALID_REPLY)
    const provider = new OpenAIProvider(client)

    const result = await provider.estimate("two scrambled eggs")

    expect(result.estimate.items).toHaveLength(1)
    expect(result.estimate.items[0].calories).toBe(180)
    expect(result.estimate.needsClarification).toBe(false)
    expect(result.estimate.confidence).toBe("high")
  })

  test("disables server-side storage on every call", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].store).toBe(false)
  })

  test("disables reasoning effort", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].reasoning).toEqual({ effort: "none" })
  })

  test("requests strict structured output, not json_object mode", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].text.format.type).toBe("json_schema")
    expect(calls[0].text.format.strict).toBe(true)
    expect(calls[0].response_format).toBeUndefined()
  })

  test("sends no temperature", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].temperature).toBeUndefined()
  })

  test("passes conversation context in the input, not via previous_response_id", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("about 200g", "earlier: grilled chicken")

    expect(JSON.stringify(calls[0].input)).toContain("grilled chicken")
    expect(calls[0].previous_response_id).toBeUndefined()
  })
})

describe("OpenAIProvider usage reporting", () => {
  test("reports tokens from the Responses usage block", async () => {
    const { client } = fakeClient(VALID_REPLY)
    const result = await new OpenAIProvider(client).estimate("two eggs")

    expect(result.usage).toEqual({
      model: "gpt-5.6-luna",
      inputTokens: 120,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 45,
      reasoningTokens: 0,
    })
    expect(result.estimate.items).toHaveLength(1)
  })
})

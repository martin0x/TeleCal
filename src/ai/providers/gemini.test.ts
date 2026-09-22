// src/ai/providers/gemini.test.ts
import { describe, test, expect } from "bun:test"
import { GeminiProvider } from "./gemini"

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  confidence: "high",
})

function fakeClient(text: string, usageMetadata?: Record<string, number>) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: {
          text: () => text,
          usageMetadata: usageMetadata ?? {
            promptTokenCount: 310,
            candidatesTokenCount: 70,
            totalTokenCount: 380,
          },
        },
      }),
    }),
  } as any
}

describe("GeminiProvider", () => {
  test("reports tokens from usageMetadata, nested under response", async () => {
    const result = await new GeminiProvider(fakeClient(VALID_REPLY)).estimate("two eggs")

    expect(result.usage.model).toBe("gemini-3.1-flash-lite")
    expect(result.usage.inputTokens).toBe(310)
    expect(result.usage.outputTokens).toBe(70)
    expect(result.estimate.items).toHaveLength(1)
  })

  test("reports zero tokens when usageMetadata is absent", async () => {
    const client = {
      getGenerativeModel: () => ({
        generateContent: async () => ({ response: { text: () => VALID_REPLY } }),
      }),
    } as any
    const result = await new GeminiProvider(client).estimate("two eggs")

    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
  })
})

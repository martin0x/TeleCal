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

  test("surfaces protein_g and nulls a non-numeric one", async () => {
    const reply = JSON.stringify({
      items: [
        { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
        { description: "Toast", calories: 120, protein_g: "some", emoji: "🍞" },
      ],
      needsClarification: false,
      confidence: "high",
    })
    const result = await new GeminiProvider(fakeClient(reply)).estimate("eggs and toast")
    expect(result.estimate.items.map((i) => i.protein_g)).toEqual([12, null])
  })

  test("asks for protein_g in the system instruction", async () => {
    const seen: any[] = []
    const client = {
      getGenerativeModel: (opts: any) => {
        seen.push(opts)
        return {
          generateContent: async () => ({ response: { text: () => VALID_REPLY, usageMetadata: {} } }),
        }
      },
    } as any
    await new GeminiProvider(client).estimate("two eggs")
    expect(seen[0].systemInstruction).toContain("protein_g")
  })
})

describe("GeminiProvider.estimateProtein", () => {
  test("sends the batch prompt and aligns the reply", async () => {
    const seen: { opts: any; input?: string } = { opts: null }
    const client = {
      getGenerativeModel: (opts: any) => {
        seen.opts = opts
        return {
          generateContent: async (input: string) => {
            seen.input = input
            return {
              response: {
                text: () => JSON.stringify({ items: [{ index: 1, protein_g: 38 }, { index: 2, protein_g: 4 }] }),
                usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 },
              },
            }
          },
        }
      },
    } as any
    const result = await new GeminiProvider(client).estimateProtein(["Chicken adobo", "Rice"])

    expect(seen.opts.systemInstruction).toContain("numbered list")
    expect(seen.input).toBe("1. Chicken adobo\n2. Rice")
    expect(result.protein).toEqual([38, 4])
    expect(result.usage).toMatchObject({ inputTokens: 80, outputTokens: 20 })
  })
})

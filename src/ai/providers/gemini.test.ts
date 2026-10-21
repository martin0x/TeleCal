// src/ai/providers/gemini.test.ts
import { describe, test, expect } from "bun:test"
import { GeminiProvider } from "./gemini"
import { ProviderParseError } from "../types"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT } from "../prompt"

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

    expect(result.usage.model).toBe("gemini-3.5-flash-lite")
    expect(result.usage.inputTokens).toBe(310)
    expect(result.usage.outputTokens).toBe(70)
    expect(result.estimate.items).toHaveLength(1)
  })

  test("counts thinking tokens as output", async () => {
    const client = fakeClient(VALID_REPLY, {
      promptTokenCount: 310,
      candidatesTokenCount: 70,
      thoughtsTokenCount: 25,
      totalTokenCount: 405,
    })
    const result = await new GeminiProvider(client).estimate("two eggs")

    expect(result.usage.outputTokens).toBe(95)
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

describe("GeminiProvider trace", () => {
  test("returns the prompt it sent and the raw reply", async () => {
    const result = await new GeminiProvider(fakeClient(VALID_REPLY)).estimate("two eggs", "earlier: breakfast")

    expect(result.trace?.input[0]).toEqual({ role: "system", content: ESTIMATE_JSON_PROMPT })
    expect(result.trace?.input[1].role).toBe("user")
    expect(result.trace?.input[1].content).toContain("two eggs")
    expect(result.trace?.input[1].content).toContain("earlier: breakfast")
    expect(result.trace?.output).toBe(VALID_REPLY)
  })

  test("an unparseable reply throws a ProviderParseError carrying usage and the raw text", async () => {
    const error = await new GeminiProvider(fakeClient("not json at all")).estimate("two eggs").catch((e) => e)

    expect(error).toBeInstanceOf(ProviderParseError)
    expect(error).toBeInstanceOf(SyntaxError)
    expect(error.usage.inputTokens).toBe(310)
    expect(error.trace.output).toBe("not json at all")
    expect(error.trace.input[1].content).toContain("two eggs")
  })

  test("the protein batch returns its prompt and raw reply too", async () => {
    const reply = JSON.stringify({ items: [{ index: 1, protein_g: 4 }] })
    const result = await new GeminiProvider(fakeClient(reply)).estimateProtein(["Rice"])

    expect(result.trace?.input[0]).toEqual({ role: "system", content: PROTEIN_BATCH_PROMPT })
    expect(result.trace?.input[1].content).toContain("Rice")
    expect(result.trace?.output).toBe(reply)
  })
})

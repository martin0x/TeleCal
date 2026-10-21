// src/ai/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai"
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, stripFences, alignProteinBatch, parseReply, traceOf } from "../parse"

const MODEL = "gemini-3.5-flash-lite"

export class GeminiProvider implements AIProvider {
  name = "gemini"
  private client: GoogleGenerativeAI

  constructor(client?: GoogleGenerativeAI) {
    this.client = client ?? new GoogleGenerativeAI(config.ai.googleApiKey)
  }

  private model(systemInstruction: string) {
    return this.client.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
      systemInstruction,
    })
  }

  private async generate(systemInstruction: string, input: string): Promise<{ text: string; usage: TokenUsage }> {
    const result = await this.model(systemInstruction).generateContent(input)
    const response = result.response
    const text = response.text()
    if (!text) {
      throw new Error("No response from Gemini")
    }
    // usageMetadata is nested under result.response, not on the result itself.
    // thoughtsTokenCount is missing from the SDK's types; thinking tokens are
    // billed as output and are not part of candidatesTokenCount.
    const meta = response.usageMetadata as
      | (NonNullable<typeof response.usageMetadata> & { thoughtsTokenCount?: number })
      | undefined
    return {
      text,
      usage: {
        model: MODEL,
        inputTokens: meta?.promptTokenCount ?? 0,
        cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
        outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      },
    }
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const { text, usage } = await this.generate(ESTIMATE_JSON_PROMPT, userMessage)
    const trace = traceOf(ESTIMATE_JSON_PROMPT, userMessage, text)
    const parsed = parseReply(stripFences(text), usage, trace) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      estimate: {
        items: normalizeItems(parsed.items),
        needsClarification: parsed.needsClarification || false,
        clarificationQuestion: parsed.clarificationQuestion,
        confidence: parsed.confidence || "medium",
      },
      usage,
      trace,
    }
  }

  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const userMessage = formatProteinBatchInput(descriptions)
    const { text, usage } = await this.generate(PROTEIN_BATCH_PROMPT, userMessage)
    const trace = traceOf(PROTEIN_BATCH_PROMPT, userMessage, text)
    return {
      protein: alignProteinBatch(parseReply(stripFences(text), usage, trace), descriptions.length),
      usage,
      trace,
    }
  }
}

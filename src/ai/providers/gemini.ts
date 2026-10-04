// src/ai/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai"
import { AIProvider, ProviderResult, ProteinBatchResult, TokenUsage } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT, PROTEIN_BATCH_PROMPT, formatProteinBatchInput } from "../prompt"
import { normalizeItems, stripFences, alignProteinBatch } from "../parse"

const MODEL = "gemini-3.1-flash-lite"

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
    const meta = response.usageMetadata
    return {
      text,
      usage: {
        model: MODEL,
        inputTokens: meta?.promptTokenCount ?? 0,
        cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
        outputTokens: meta?.candidatesTokenCount ?? 0,
      },
    }
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const { text, usage } = await this.generate(ESTIMATE_JSON_PROMPT, userMessage)
    const parsed = JSON.parse(stripFences(text)) as {
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
    }
  }

  async estimateProtein(descriptions: string[]): Promise<ProteinBatchResult> {
    const { text, usage } = await this.generate(PROTEIN_BATCH_PROMPT, formatProteinBatchInput(descriptions))
    return {
      protein: alignProteinBatch(JSON.parse(stripFences(text)), descriptions.length),
      usage,
    }
  }
}

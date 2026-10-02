// src/ai/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai"
import { AIProvider, ProviderResult } from "../types"
import { config } from "../../config"
import { ESTIMATE_JSON_PROMPT } from "../prompt"
import { normalizeItems, stripFences } from "../parse"

export class GeminiProvider implements AIProvider {
  name = "gemini"
  private client: GoogleGenerativeAI

  constructor(client?: GoogleGenerativeAI) {
    this.client = client ?? new GoogleGenerativeAI(config.ai.googleApiKey)
  }

  async estimate(foodDescription: string, context?: string): Promise<ProviderResult> {
    const model = this.client.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
      systemInstruction: ESTIMATE_JSON_PROMPT,
    })

    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const result = await model.generateContent(userMessage)
    const response = result.response
    const content = response.text()

    if (!content) {
      throw new Error("No response from Gemini")
    }

    const parsed = JSON.parse(stripFences(content)) as {
      items: unknown
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    // usageMetadata is nested under result.response, not on the result itself.
    const meta = response.usageMetadata

    return {
      estimate: {
        items: normalizeItems(parsed.items),
        needsClarification: parsed.needsClarification || false,
        clarificationQuestion: parsed.clarificationQuestion,
        confidence: parsed.confidence || "medium",
      },
      usage: {
        model: "gemini-3.1-flash-lite",
        inputTokens: meta?.promptTokenCount ?? 0,
        cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
        outputTokens: meta?.candidatesTokenCount ?? 0,
      },
    }
  }
}

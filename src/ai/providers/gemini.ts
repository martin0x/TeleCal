// src/ai/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai"
import { AIProvider, ProviderResult, MacroBatchResult, TokenUsage, type FoodsParseResult } from "../types"
import { config } from "../../config"
import {
  ESTIMATE_JSON_PROMPT,
  MACRO_BATCH_PROMPT,
  FOODS_PARSE_PROMPT,
  FOODS_MAX_TOKENS,
  formatBatchInput,
  estimateUserMessage,
} from "../prompt"
import { normalizeItems, stripFences, alignMacroBatch, parseReply, traceOf, normalizeFoodsReply } from "../parse"

const MODEL = "gemini-3.5-flash-lite"

export class GeminiProvider implements AIProvider {
  name = "gemini"
  private client: GoogleGenerativeAI

  constructor(client?: GoogleGenerativeAI) {
    this.client = client ?? new GoogleGenerativeAI(config.ai.googleApiKey)
  }

  /** maxOutputTokens is only set in generationConfig when given, so estimate/estimateMacros keep today's request shape. */
  private model(systemInstruction: string, maxOutputTokens?: number) {
    return this.client.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      },
      systemInstruction,
    })
  }

  private async generate(
    systemInstruction: string,
    input: string,
    maxOutputTokens?: number
  ): Promise<{ text: string; usage: TokenUsage }> {
    const result = await this.model(systemInstruction, maxOutputTokens).generateContent(input)
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

  async estimate(foodDescription: string, context?: string, savedFoods?: string): Promise<ProviderResult> {
    const userMessage = estimateUserMessage(foodDescription, context, savedFoods)

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

  async estimateMacros(descriptions: string[]): Promise<MacroBatchResult> {
    const userMessage = formatBatchInput(descriptions)
    const { text, usage } = await this.generate(MACRO_BATCH_PROMPT, userMessage)
    const trace = traceOf(MACRO_BATCH_PROMPT, userMessage, text)
    return {
      values: alignMacroBatch(parseReply(stripFences(text), usage, trace), descriptions.length),
      usage,
      trace,
    }
  }

  async parseFoods(text: string): Promise<FoodsParseResult> {
    const { text: output, usage } = await this.generate(FOODS_PARSE_PROMPT, text, FOODS_MAX_TOKENS)
    const trace = traceOf(FOODS_PARSE_PROMPT, text, output)
    return { reply: normalizeFoodsReply(parseReply(stripFences(output), usage, trace)), usage, trace }
  }
}

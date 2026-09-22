// src/ai/service.ts
import { AIProvider, EstimationResult } from "./types"
import { OpenAIProvider } from "./providers/openai"
import { AnthropicProvider } from "./providers/anthropic"
import { GeminiProvider } from "./providers/gemini"
import { CacheRepository } from "../db/repositories/cache"
import { UsageRepository } from "../db/repositories/usage"
import { calculateCost } from "./pricing"
import type { CallType, UsageStatus, TokenUsage } from "./types"
import { config } from "../config"

export interface EstimateOptions {
  telegramId: number
  chatId: number | null
  callType: CallType
  context?: string
}

export class AIService {
  private providers: Map<string, AIProvider> = new Map()

  constructor(
    private cache: CacheRepository,
    private usage: UsageRepository
  ) {
    if (config.ai.openaiApiKey) {
      this.providers.set("openai", new OpenAIProvider())
    }
    if (config.ai.anthropicApiKey) {
      this.providers.set("anthropic", new AnthropicProvider())
    }
    if (config.ai.googleApiKey) {
      this.providers.set("gemini", new GeminiProvider())
    }
  }

  async estimate(
    foodDescription: string,
    providerName: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    const normalizedFood = this.normalizeFood(foodDescription)

    // Check cache first (only if no context and caching enabled)
    if (!opts.context && config.features.caching) {
      const cached = this.cache.get(normalizedFood)
      if (cached) return cached // nothing billed, nothing recorded
    }

    const provider = this.providers.get(providerName) ?? this.providers.values().next().value
    if (!provider) {
      throw new Error("No AI provider configured")
    }

    return this.estimateWithProvider(provider, foodDescription, normalizedFood, opts)
  }

  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    let result
    try {
      result = await provider.estimate(foodDescription, opts.context)
    } catch (error) {
      // A JSON parse failure means the API replied and billed us, but the body
      // was unusable. Any other error means no usable response at all, so there
      // is nothing to attribute.
      if (error instanceof SyntaxError) {
        this.recordSafely(
          provider.name,
          { model: "unknown", inputTokens: 0, outputTokens: 0 },
          opts,
          "parse_error"
        )
      }
      throw error
    }

    const status: UsageStatus =
      result.usage.inputTokens === 0 && result.usage.outputTokens === 0 ? "no_usage" : "ok"
    this.recordSafely(provider.name, result.usage, opts, status)

    const estimate = result.estimate
    if (!estimate.needsClarification && !opts.context && config.features.caching) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }

  /** Accounting must never break calorie logging. */
  private recordSafely(
    providerName: string,
    usage: TokenUsage,
    opts: EstimateOptions,
    status: UsageStatus
  ): void {
    try {
      this.usage.record({
        telegramId: opts.telegramId,
        chatId: opts.chatId,
        provider: providerName,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens ?? null,
        costUsd: calculateCost(usage),
        callType: opts.callType,
        status,
      })
    } catch (error) {
      console.error("[usage] Failed to record AI usage:", error)
    }
  }

  private normalizeFood(food: string): string {
    return food
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }
}

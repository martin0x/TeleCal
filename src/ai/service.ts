// src/ai/service.ts
import { Database } from "bun:sqlite"
import { AIProvider, EstimationResult, CachedEstimation } from "./types"
import { OpenAIProvider } from "./providers/openai"
import { AnthropicProvider } from "./providers/anthropic"
import { GeminiProvider } from "./providers/gemini"
import { config } from "../config"

export class AIService {
  private providers: Map<string, AIProvider> = new Map()
  private db: Database

  constructor(db: Database) {
    this.db = db

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
    providerName: string = "openai",
    context?: string
  ): Promise<EstimationResult> {
    const normalizedFood = this.normalizeFood(foodDescription)

    // Check cache first (only if no context and caching enabled)
    if (!context && config.features.caching) {
      const cached = this.getFromCache(normalizedFood)
      if (cached) {
        return cached
      }
    }

    const provider = this.providers.get(providerName)
    if (!provider) {
      // Fallback to any available provider
      const fallback = this.providers.values().next().value
      if (!fallback) {
        throw new Error("No AI provider configured")
      }
      return this.estimateWithProvider(fallback, foodDescription, normalizedFood, context)
    }

    return this.estimateWithProvider(provider, foodDescription, normalizedFood, context)
  }

  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    context?: string
  ): Promise<EstimationResult> {
    const result = await provider.estimate(foodDescription, context)

    // Cache successful results without clarification needed
    if (!result.needsClarification && !context && config.features.caching) {
      this.saveToCache(normalizedFood, result)
    }

    return result
  }

  private normalizeFood(food: string): string {
    return food
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
  }

  private getFromCache(normalizedFood: string): EstimationResult | null {
    const stmt = this.db.prepare(
      "SELECT result_json FROM estimation_cache WHERE normalized_food = ?"
    )
    const row = stmt.get(normalizedFood) as CachedEstimation | null
    if (row) {
      return JSON.parse(row.result_json) as EstimationResult
    }
    return null
  }

  private saveToCache(normalizedFood: string, result: EstimationResult): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO estimation_cache (normalized_food, result_json, created_at)
      VALUES (?, ?, datetime('now'))
    `)
    stmt.run(normalizedFood, JSON.stringify(result))
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }
}

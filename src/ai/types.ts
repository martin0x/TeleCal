// src/ai/types.ts

export interface FoodEstimate {
  description: string
  calories: number
  emoji?: string
}

export interface EstimationResult {
  items: FoodEstimate[]
  needsClarification: boolean
  clarificationQuestion?: string
  confidence: "high" | "medium" | "low"
}

export interface AIProvider {
  name: string
  estimate(foodDescription: string, context?: string): Promise<ProviderResult>
}

export interface CachedEstimation {
  normalized_food: string
  result_json: string
  created_at: string
}

export interface TokenUsage {
  /** Model id as reported by the API, falling back to the requested constant. */
  model: string
  inputTokens: number
  /** Subset of inputTokens billed at the cached rate. */
  cachedInputTokens?: number
  /** Subset of inputTokens written to cache. Recorded, not separately priced. */
  cacheWriteTokens?: number
  outputTokens: number
  /** Subset of outputTokens. Already billed as output — never add it again. */
  reasoningTokens?: number
}

export interface ProviderResult {
  estimate: EstimationResult
  usage: TokenUsage
}

export type CallType = "estimate" | "clarify" | "edit" | "retry"

export type UsageStatus = "ok" | "parse_error" | "no_usage"

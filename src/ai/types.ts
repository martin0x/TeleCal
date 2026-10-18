// src/ai/types.ts

export interface FoodEstimate {
  description: string
  calories: number
  /** Whole grams. null when the model gave nothing usable; the backfill fills it later. */
  protein_g: number | null
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
  /** Protein for many descriptions in one call; the caller chunks. */
  estimateProtein(descriptions: string[]): Promise<ProteinBatchResult>
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

/** What one call sent and got back, for LLM analytics. */
export interface AITrace {
  /** The system prompt, then the user message. */
  input: { role: "system" | "user"; content: string }[]
  /** The model's raw reply text, before parsing. */
  output: string
}

export interface ProviderResult {
  estimate: EstimationResult
  usage: TokenUsage
  trace?: AITrace
}

export interface ProteinBatchResult {
  /** Aligned with the input array. null where the model gave nothing usable. */
  protein: (number | null)[]
  usage: TokenUsage
  trace?: AITrace
}

/**
 * The model replied, and was billed, but the reply wasn't valid JSON. Still a
 * SyntaxError, so existing checks hold; carries what the call cost and said.
 */
export class ProviderParseError extends SyntaxError {
  constructor(
    cause: SyntaxError,
    readonly usage: TokenUsage,
    readonly trace: AITrace
  ) {
    super(cause.message, { cause })
    this.name = "ProviderParseError"
  }
}

export type CallType = "estimate" | "clarify" | "edit" | "retry" | "backfill"

export type UsageStatus = "ok" | "parse_error" | "no_usage"

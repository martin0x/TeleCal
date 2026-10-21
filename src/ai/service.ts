// src/ai/service.ts
import { randomUUID } from "node:crypto"
import { AIProvider, EstimationResult, ProteinBatchResult, ProviderParseError, type AITrace } from "./types"
import { OpenAIProvider } from "./providers/openai"
import { AnthropicProvider } from "./providers/anthropic"
import { GeminiProvider } from "./providers/gemini"
import { CacheRepository } from "../db/repositories/cache"
import { UsageRepository } from "../db/repositories/usage"
import { calculateCost } from "./pricing"
import type { CallType, UsageStatus, TokenUsage } from "./types"
import { config } from "../config"
import { noopAnalytics, type Analytics } from "../analytics"
import { CircuitBreaker } from "./circuit-breaker"
import { classifyFailure, describeFailure, type FailureKind } from "./failures"
import type { ProviderFallback } from "./fallback"

export interface EstimateOptions {
  telegramId: number
  chatId: number | null
  callType: CallType
  context?: string
}

export interface ProteinOptions {
  telegramId: number
  chatId: number | null
}

/**
 * Cached results written before protein tracking have no protein_g. Treating
 * them as misses lets the cache heal itself one description at a time instead
 * of needing a wipe or a version key.
 */
export function isCurrentShape(result: EstimationResult): boolean {
  return result.items.every((item) => typeof item.protein_g === "number" && Number.isFinite(item.protein_g))
}

/** An estimate, plus who answered when it wasn't the user's provider. */
export interface ServiceEstimate extends EstimationResult {
  fallback?: ProviderFallback
}

export class AIService {
  // Insertion order is the fallback order.
  private providers: Map<string, AIProvider> = new Map()

  constructor(
    private cache: CacheRepository,
    private usage: UsageRepository,
    private analytics: Analytics = noopAnalytics,
    readonly breaker: CircuitBreaker = new CircuitBreaker()
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

  /**
   * Tries the user's provider first, then the others in order, moving on only
   * when a provider is skipped by the circuit breaker or fails in a way
   * another could fix (see classifyFailure). Any other error is thrown as is.
   */
  async estimate(
    foodDescription: string,
    providerName: string,
    opts: EstimateOptions
  ): Promise<ServiceEstimate> {
    const normalizedFood = this.normalizeFood(foodDescription)

    // Check cache first (only if no context and caching enabled)
    if (!opts.context && config.features.caching) {
      const cached = this.cache.get(normalizedFood)
      if (cached && isCurrentShape(cached)) return cached // nothing billed, nothing recorded
    }

    const chain = this.providerChain(providerName)
    if (chain.length === 0) {
      throw new Error("No AI provider configured")
    }

    let reason: FailureKind | undefined
    let lastError: unknown
    for (const provider of chain) {
      if (!this.breaker.tryAcquire(provider.name)) {
        reason ??= "down"
        continue
      }

      let estimate: EstimationResult
      try {
        estimate = await this.estimateWithProvider(provider, foodDescription, normalizedFood, opts)
      } catch (error) {
        const kind = classifyFailure(error)
        if (!kind) {
          this.breaker.release(provider.name)
          throw error
        }
        this.breaker.recordFailure(provider.name, error)
        reason ??= kind
        lastError = error
        continue
      }

      this.breaker.recordSuccess(provider.name)
      if (provider === chain[0]) return estimate
      return { ...estimate, fallback: { from: chain[0].name, to: provider.name, reason: reason! } }
    }

    throw lastError ?? new Error("Every AI provider is failing; skipped until they recover")
  }

  /** The named provider first (when configured), then the rest in order. */
  private providerChain(providerName: string): AIProvider[] {
    const first = this.providers.get(providerName)
    const rest = [...this.providers.values()].filter((p) => p !== first)
    return first ? [first, ...rest] : rest
  }

  /**
   * Protein for many descriptions in one billed call. No cache: the backfill
   * is the only caller and it only asks about rows that have no protein yet.
   */
  async estimateProtein(
    descriptions: string[],
    providerName: string,
    opts: ProteinOptions
  ): Promise<(number | null)[]> {
    const provider = this.resolveProvider(providerName)
    const recordOpts: EstimateOptions = { ...opts, callType: "backfill" }

    let result: ProteinBatchResult
    const started = performance.now()
    try {
      result = await provider.estimateProtein(descriptions)
    } catch (error) {
      this.recordFailure(error, provider.name, recordOpts, performance.now() - started)
      throw error
    }

    this.recordSafely(provider.name, result.usage, recordOpts, this.statusFor(result.usage), {
      trace: result.trace,
      latencyMs: performance.now() - started,
    })
    return result.protein
  }

  private resolveProvider(providerName: string): AIProvider {
    const provider = this.providers.get(providerName) ?? this.providers.values().next().value
    if (!provider) {
      throw new Error("No AI provider configured")
    }
    return provider
  }

  private statusFor(usage: TokenUsage): UsageStatus {
    return usage.inputTokens === 0 && usage.outputTokens === 0 ? "no_usage" : "ok"
  }

  private async estimateWithProvider(
    provider: AIProvider,
    foodDescription: string,
    normalizedFood: string,
    opts: EstimateOptions
  ): Promise<EstimationResult> {
    let result
    const started = performance.now()
    try {
      result = await provider.estimate(foodDescription, opts.context)
    } catch (error) {
      this.recordFailure(error, provider.name, opts, performance.now() - started)
      throw error
    }

    this.recordSafely(provider.name, result.usage, opts, this.statusFor(result.usage), {
      trace: result.trace,
      latencyMs: performance.now() - started,
    })

    const estimate = result.estimate
    // A result with unknown protein is not worth keeping: the next ask should
    // get another chance at a complete answer.
    if (!estimate.needsClarification && !opts.context && config.features.caching && isCurrentShape(estimate)) {
      this.cache.set(normalizedFood, estimate)
    }

    return estimate
  }

  /** Every provider failure, whether or not the call was billed. */
  private reportFailure(error: unknown, providerName: string, opts: EstimateOptions): void {
    this.analytics.captureException(error, opts.telegramId, {
      source: "ai",
      provider: providerName,
      call_type: opts.callType,
      status: error instanceof SyntaxError ? "parse_error" : "request_failed",
    })
  }

  /**
   * A JSON parse failure means the API replied and billed us, but the body was
   * unusable: record it with whatever usage the provider attached. Any other
   * error means no usable response at all: a request_failed row with no
   * tokens, for provider health, and no $ai_generation since nothing was
   * billed. Either way the failure goes to error tracking.
   */
  private recordFailure(error: unknown, providerName: string, opts: EstimateOptions, latencyMs: number): void {
    if (error instanceof ProviderParseError) {
      this.recordSafely(providerName, error.usage, opts, "parse_error", { trace: error.trace, latencyMs, error })
    } else if (error instanceof SyntaxError) {
      this.recordSafely(providerName, { model: "unknown", inputTokens: 0, outputTokens: 0 }, opts, "parse_error", {
        latencyMs,
        error,
      })
    } else {
      this.writeUsage(providerName, { model: "unknown", inputTokens: 0, outputTokens: 0 }, 0, opts, "request_failed", {
        latencyMs,
        error: describeFailure(error),
      })
    }
    this.reportFailure(error, providerName, opts)
  }

  /**
   * Writes the ai_usage row (the source of truth for cost), then sends the
   * same call to PostHog as $ai_generation. Accounting must never break
   * calorie logging; analytics.capture swallows its own errors.
   */
  private recordSafely(
    providerName: string,
    usage: TokenUsage,
    opts: EstimateOptions,
    status: UsageStatus,
    generation?: { trace?: AITrace; latencyMs: number; error?: unknown }
  ): void {
    const costUsd = calculateCost(usage)
    this.writeUsage(providerName, usage, costUsd, opts, status, { latencyMs: generation?.latencyMs })

    if (!generation) return
    const { trace, latencyMs, error } = generation
    this.analytics.capture(opts.telegramId, "$ai_generation", {
      // Each call is its own trace: threading one ID through a /log
      // conversation would need it stored in conversation_state.
      $ai_trace_id: randomUUID(),
      $ai_span_name: opts.callType,
      $ai_provider: providerName,
      $ai_model: usage.model,
      $ai_input_tokens: usage.inputTokens,
      $ai_output_tokens: usage.outputTokens,
      $ai_cache_read_input_tokens: usage.cachedInputTokens ?? 0,
      $ai_cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
      // TokenUsage counts cached tokens inside inputTokens.
      $ai_cache_reporting_exclusive: false,
      reasoning_tokens: usage.reasoningTokens ?? 0,
      $ai_latency: latencyMs / 1000,
      $ai_input: trace?.input,
      $ai_output_choices: trace ? [{ role: "assistant", content: trace.output }] : undefined,
      $ai_total_cost_usd: costUsd,
      $ai_is_error: status === "parse_error",
      $ai_error: error instanceof Error ? error.message : undefined,
      call_type: opts.callType,
      status,
    })
  }

  /** The ai_usage row. Accounting must never break calorie logging. */
  private writeUsage(
    providerName: string,
    usage: TokenUsage,
    costUsd: number,
    opts: EstimateOptions,
    status: UsageStatus,
    extra: { latencyMs?: number; error?: string }
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
        costUsd,
        callType: opts.callType,
        status,
        latencyMs: extra.latencyMs ?? null,
        error: extra.error ?? null,
      })
    } catch (error) {
      console.error("[usage] Failed to record AI usage:", error)
      this.analytics.captureException(error, opts.telegramId, { source: "usage", call_type: opts.callType })
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

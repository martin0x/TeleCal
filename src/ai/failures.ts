// src/ai/failures.ts
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import {
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
} from "@google/generative-ai"

/**
 * Per-request limits for every provider. The SDK defaults (a 10 minute
 * timeout, two retries) would keep a user waiting through an outage before
 * the next provider got a chance.
 */
export const REQUEST_TIMEOUT_MS = 30_000
export const MAX_SDK_RETRIES = 1

/**
 * Why a provider couldn't answer, when another provider might:
 * - busy: rate limited or overloaded (429, Anthropic's 529)
 * - down: a server error, a timeout, or no connection at all
 */
export type FailureKind = "busy" | "down"

function statusOf(error: unknown): number | undefined {
  if (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError) return error.status
  if (error instanceof GoogleGenerativeAIFetchError) return error.status
  return undefined
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof GoogleGenerativeAIAbortError
  )
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) return true
  // The Gemini SDK wraps a failed fetch in its base error class, keeping only the message.
  return (
    error instanceof GoogleGenerativeAIError &&
    error.constructor === GoogleGenerativeAIError &&
    error.message.includes("Error fetching from")
  )
}

/**
 * Whether another provider could answer where this one failed, and why. null
 * for everything else: a reply we couldn't parse is a prompt or model problem,
 * and a bad key or unknown model is a config problem that should stay loud.
 */
export function classifyFailure(error: unknown): FailureKind | null {
  if (error instanceof SyntaxError) return null
  if (isTimeout(error) || isConnectionFailure(error)) return "down"

  const status = statusOf(error)
  if (status === undefined) return null
  if (status === 429 || status === 529) return "busy"
  if (status === 408 || status >= 500) return "down"
  return null
}

/** A short label for a failure, stored in ai_usage.error and shown to admins. */
export function describeFailure(error: unknown): string {
  if (isTimeout(error)) return "timeout"
  if (isConnectionFailure(error)) return "connection error"
  const status = statusOf(error)
  if (status !== undefined) return `HTTP ${status}`
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}

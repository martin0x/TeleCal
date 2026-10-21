// src/ai/failures.test.ts
import { describe, test, expect } from "bun:test"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import {
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
} from "@google/generative-ai"
import { classifyFailure, describeFailure } from "./failures"
import { ProviderParseError } from "./types"

const openaiError = (status: number) => OpenAI.APIError.generate(status, undefined, "boom", new Headers())
const anthropicError = (status: number) => Anthropic.APIError.generate(status, undefined, "boom", new Headers())

describe("classifyFailure", () => {
  test("rate limits and Anthropic's overloaded status are busy", () => {
    expect(classifyFailure(openaiError(429))).toBe("busy")
    expect(classifyFailure(anthropicError(429))).toBe("busy")
    expect(classifyFailure(anthropicError(529))).toBe("busy")
    expect(classifyFailure(new GoogleGenerativeAIFetchError("quota", 429))).toBe("busy")
  })

  test("server errors and request timeouts are down", () => {
    expect(classifyFailure(openaiError(500))).toBe("down")
    expect(classifyFailure(anthropicError(503))).toBe("down")
    expect(classifyFailure(openaiError(408))).toBe("down")
    expect(classifyFailure(new GoogleGenerativeAIFetchError("unavailable", 503))).toBe("down")
  })

  test("timeouts and lost connections are down", () => {
    expect(classifyFailure(new OpenAI.APIConnectionTimeoutError())).toBe("down")
    expect(classifyFailure(new Anthropic.APIConnectionError({ message: "reset" }))).toBe("down")
    expect(classifyFailure(new GoogleGenerativeAIAbortError("Request aborted"))).toBe("down")
    expect(classifyFailure(new GoogleGenerativeAIError("Error fetching from https://x: fetch failed"))).toBe("down")
  })

  test("config errors stay loud: no fallback", () => {
    expect(classifyFailure(openaiError(401))).toBeNull()
    expect(classifyFailure(anthropicError(403))).toBeNull()
    expect(classifyFailure(openaiError(404))).toBeNull()
    expect(classifyFailure(anthropicError(400))).toBeNull()
    expect(classifyFailure(new GoogleGenerativeAIFetchError("bad key", 400))).toBeNull()
  })

  test("a reply that couldn't be parsed is not an outage", () => {
    const usage = { model: "m", inputTokens: 1, outputTokens: 1 }
    expect(classifyFailure(new SyntaxError("Unexpected token"))).toBeNull()
    expect(classifyFailure(new ProviderParseError(new SyntaxError("x"), usage, { input: [], output: "" }))).toBeNull()
  })

  test("anything else is not classified", () => {
    expect(classifyFailure(new Error("No response from OpenAI"))).toBeNull()
    expect(classifyFailure(new GoogleGenerativeAIResponseError("blocked"))).toBeNull()
    expect(classifyFailure(new GoogleGenerativeAIError("Failed to parse stream"))).toBeNull()
    expect(classifyFailure("string")).toBeNull()
  })
})

describe("describeFailure", () => {
  test("labels HTTP errors by status, and timeouts and connections by kind", () => {
    expect(describeFailure(anthropicError(529))).toBe("HTTP 529")
    expect(describeFailure(new GoogleGenerativeAIFetchError("x", 503))).toBe("HTTP 503")
    expect(describeFailure(new OpenAI.APIConnectionTimeoutError())).toBe("timeout")
    expect(describeFailure(new Anthropic.APIConnectionError({ message: "reset" }))).toBe("connection error")
  })

  test("falls back to the class and message, capped", () => {
    expect(describeFailure(new TypeError("bad"))).toBe("TypeError: bad")
    expect(describeFailure(new Error("x".repeat(500)))).toHaveLength(200)
  })
})

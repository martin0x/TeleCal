// src/ai/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk"
import { AIProvider, EstimationResult, FoodEstimate } from "../types"
import { config } from "../../config"

const SYSTEM_PROMPT = `You are a nutrition expert that estimates calories in food.

When given a food description, respond with ONLY a JSON object (no markdown, no explanation) containing:
- items: array of {description, calories, emoji} for each food item
- needsClarification: boolean - true if the description is too vague
- clarificationQuestion: string - question to ask if clarification needed
- confidence: "high" | "medium" | "low"

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include relevant emoji for each food item
- If multiple items mentioned, break them down separately
- If quantity/size is unclear, ask for clarification

Example input: "chicken sandwich and fries"
Example output:
{"items":[{"description":"Chicken sandwich","calories":450,"emoji":"🥪"},{"description":"French fries (medium)","calories":365,"emoji":"🍟"}],"needsClarification":false,"confidence":"medium"}`

export class AnthropicProvider implements AIProvider {
  name = "anthropic"
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({
      apiKey: config.ai.anthropicApiKey,
    })
  }

  async estimate(foodDescription: string, context?: string): Promise<EstimationResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })

    const content = response.content[0]
    if (content.type !== "text") {
      throw new Error("Unexpected response type from Anthropic")
    }

    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = content.text.trim()
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```$/g, "").trim()
    }

    const result = JSON.parse(jsonStr) as {
      items: FoodEstimate[]
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      items: result.items || [],
      needsClarification: result.needsClarification || false,
      clarificationQuestion: result.clarificationQuestion,
      confidence: result.confidence || "medium",
    }
  }
}

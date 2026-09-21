// src/ai/providers/openai.ts
import OpenAI from "openai"
import { AIProvider, EstimationResult, FoodEstimate } from "../types"
import { config } from "../../config"

const SYSTEM_PROMPT = `You are a nutrition expert that estimates calories in food.

When given a food description, respond with a JSON object containing:
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
{
  "items": [
    {"description": "Chicken sandwich", "calories": 450, "emoji": "🥪"},
    {"description": "French fries (medium)", "calories": 365, "emoji": "🍟"}
  ],
  "needsClarification": false,
  "confidence": "medium"
}

Example input: "some chicken"
Example output:
{
  "items": [],
  "needsClarification": true,
  "clarificationQuestion": "How was the chicken prepared (grilled, fried, etc.) and approximately how much?",
  "confidence": "low"
}`

export class OpenAIProvider implements AIProvider {
  name = "openai"
  private client: OpenAI

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  async estimate(foodDescription: string, context?: string): Promise<EstimationResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.chat.completions.create({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    const result = JSON.parse(content) as {
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

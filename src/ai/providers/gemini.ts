// src/ai/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai"
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

export class GeminiProvider implements AIProvider {
  name = "gemini"
  private client: GoogleGenerativeAI

  constructor() {
    this.client = new GoogleGenerativeAI(config.ai.googleApiKey)
  }

  async estimate(foodDescription: string, context?: string): Promise<EstimationResult> {
    const model = this.client.getGenerativeModel({
      model: "gemini-3-flash",
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
      systemInstruction: SYSTEM_PROMPT,
    })

    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const result = await model.generateContent(userMessage)
    const response = result.response
    const content = response.text()

    if (!content) {
      throw new Error("No response from Gemini")
    }

    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = content.trim()
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```$/g, "").trim()
    }

    const parsed = JSON.parse(jsonStr) as {
      items: FoodEstimate[]
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      items: parsed.items || [],
      needsClarification: parsed.needsClarification || false,
      clarificationQuestion: parsed.clarificationQuestion,
      confidence: parsed.confidence || "medium",
    }
  }
}

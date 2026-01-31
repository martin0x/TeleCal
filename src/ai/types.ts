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
  estimate(foodDescription: string, context?: string): Promise<EstimationResult>
}

export interface CachedEstimation {
  normalized_food: string
  result_json: string
  created_at: string
}

// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
import { Database } from "bun:sqlite"
import { AIService } from "../src/ai/service"

const provider = process.argv[2]
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini>")
  process.exit(1)
}

const db = new Database(":memory:")
db.run(`
  CREATE TABLE estimation_cache (
    normalized_food TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)

const service = new AIService(db)

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
  const result = await service.estimate("two scrambled eggs and a slice of toast", provider)
  console.log(`✓ ${provider} responded`)
  console.log(JSON.stringify(result, null, 2))
  if (result.items.length === 0 && !result.needsClarification) {
    console.error("✗ Empty items with no clarification request — the model replied, but not usefully.")
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error)
  process.exit(1)
}

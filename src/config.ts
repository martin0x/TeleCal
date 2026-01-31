// src/config.ts
function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key]
  return value ? parseInt(value, 10) : defaultValue
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (value === undefined) return defaultValue
  return value.toLowerCase() === "true"
}

function getEnvArray(key: string, defaultValue: number[] = []): number[] {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.split(",").map((s) => parseInt(s.trim(), 10))
}

export const config = {
  telegram: {
    botToken: getEnv("TELEGRAM_BOT_TOKEN"),
  },
  adminUsers: getEnvArray("ADMIN_USERS"),
  ai: {
    openaiApiKey: getEnv("OPENAI_API_KEY", ""),
    anthropicApiKey: getEnv("ANTHROPIC_API_KEY", ""),
    googleApiKey: getEnv("GOOGLE_API_KEY", ""),
  },
  web: {
    appUrl: getEnv("APP_URL", "http://localhost:3000"),
    port: getEnvNumber("PORT", 3000),
  },
  features: {
    caching: getEnvBoolean("FEATURE_CACHING", true),
    localFoodDb: getEnvBoolean("FEATURE_LOCAL_FOOD_DB", false),
  },
  timing: {
    reminderCheckInterval: getEnvNumber("REMINDER_CHECK_INTERVAL", 60000),
    pendingRetryInterval: getEnvNumber("PENDING_RETRY_INTERVAL", 300000),
    conversationTimeout: getEnvNumber("CONVERSATION_TIMEOUT", 600000),
  },
}

export type Config = typeof config

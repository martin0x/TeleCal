// src/utils/logging.ts

/**
 * Redact a user ID for safe logging.
 * Shows first 2 and last 2 digits, hides the rest.
 *
 * Example: 123456789 → "12****89"
 */
export function redactUserId(id: number): string {
  const str = String(id)
  if (str.length <= 4) return "****"
  return str.slice(0, 2) + "****" + str.slice(-2)
}

/**
 * Redact potentially sensitive text (food descriptions, etc.)
 * Truncates to max length and adds ellipsis.
 */
export function redactText(text: string, maxLength: number = 30): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + "..."
}

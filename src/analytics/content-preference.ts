// src/analytics/content-preference.ts
// The /settings option to keep meal text out of PostHog (#18). Applied once,
// around the Analytics every caller already gets, so no capture site checks it.
import type { Analytics } from "./index"

/** The properties that carry what the user typed or the AI replied. */
const CONTENT_PROPERTIES = ["$ai_input", "$ai_output_choices", "$ai_error"]

const REDACTED = "[redacted]"

/**
 * Same type and stack frames, no message: messages can quote an AI reply or
 * the user's text. The frame lines ("    at ...") are code locations only.
 */
function redact(error: unknown): Error {
  const copy = new Error(REDACTED)
  if (error instanceof Error) {
    copy.name = error.name
    const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line))
    copy.stack = [`${error.name}: ${REDACTED}`, ...frames].join("\n")
  }
  return copy
}

/**
 * `allowsContent` is read on every call, so a change in /settings applies to
 * the next event. If it throws, the user counts as opted out.
 */
export function withContentPreference(
  analytics: Analytics,
  allowsContent: (telegramId: number) => boolean
): Analytics {
  // The inner Analytics reports each error object once; handing it the same
  // copy for the same original keeps that working.
  const copies = new WeakMap<object, Error>()

  const allows = (telegramId: number) => {
    try {
      return allowsContent(telegramId)
    } catch (error) {
      console.error("[analytics] Couldn't read the meal text preference; leaving text out:", error)
      return false
    }
  }

  const redacted = (error: unknown) => {
    if (typeof error !== "object" || error === null) return redact(error)
    let copy = copies.get(error)
    if (!copy) {
      copy = redact(error)
      copies.set(error, copy)
    }
    return copy
  }

  return {
    capture(telegramId, event, properties) {
      if (!properties || allows(telegramId)) return analytics.capture(telegramId, event, properties)
      const kept = { ...properties }
      for (const key of CONTENT_PROPERTIES) delete kept[key]
      analytics.capture(telegramId, event, kept)
    },

    captureException(error, telegramId, properties) {
      if (telegramId === undefined || allows(telegramId)) {
        return analytics.captureException(error, telegramId, properties)
      }
      analytics.captureException(redacted(error), telegramId, properties)
    },

    shutdown: () => analytics.shutdown(),
  }
}

// src/jobs/report.ts
import type { Analytics } from "../analytics"

/** Catch handler for a whole job run: log it and report it. */
export function reportJobFailure(analytics: Analytics, source: string) {
  return (error: unknown) => {
    console.error(`[${source}] job run failed:`, error)
    analytics.captureException(error, undefined, { source })
  }
}

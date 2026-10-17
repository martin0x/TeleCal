// src/process-errors.ts
import type { Analytics } from "./analytics"

interface ProcessErrorDeps {
  analytics: Analytics
  exit: (code: number) => void
}

/**
 * Last-resort handlers for errors nothing else caught. An unhandled rejection
 * is reported and the bot keeps running; an uncaught exception leaves the
 * process in an unknown state, so it is reported, flushed, and the process
 * exits for Railway to restart.
 */
export function createProcessErrorHandlers(deps: ProcessErrorDeps) {
  return {
    onUnhandledRejection(reason: unknown) {
      console.error("Unhandled promise rejection:", reason)
      deps.analytics.captureException(reason, undefined, { source: "unhandledRejection" })
    },

    async onUncaughtException(error: unknown) {
      console.error("Uncaught exception, exiting:", error)
      deps.analytics.captureException(error, undefined, { source: "uncaughtException" })
      await deps.analytics.shutdown()
      deps.exit(1)
    },
  }
}

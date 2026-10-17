// src/shutdown.ts
import type { Analytics } from "./analytics"

interface ShutdownDeps {
  /** Stops the bot, web server and background jobs. */
  stop: () => void
  analytics: Pick<Analytics, "shutdown">
  exit: (code: number) => void
}

/**
 * One shutdown path for SIGINT (Ctrl-C) and SIGTERM (Railway redeploys).
 * Analytics batches events, so exiting before its flush drops them.
 */
export function createShutdown(deps: ShutdownDeps) {
  let shuttingDown = false
  return async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`${signal} received, shutting down...`)
    deps.stop()
    await deps.analytics.shutdown()
    deps.exit(0)
  }
}

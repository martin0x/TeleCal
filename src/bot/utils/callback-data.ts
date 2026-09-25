// src/bot/utils/callback-data.ts
// Payload formats for the /log and /delete confirmation buttons. Every button
// carries the id of the user it was sent to: in a group chat anyone can press
// any keyboard, and ctx.from is the presser, not the owner. Telegram caps
// callback data at 64 bytes.

export type LogAction = "ok" | "chg" | "cxl"

export interface LogCallback {
  action: LogAction
  ownerId: number
  token: string
}

export type DeleteCallback =
  | { action: "one"; ownerId: number; itemId: number }
  | { action: "all"; ownerId: number; date: string; token: string }
  | { action: "cxl"; ownerId: number }

const TOKEN = /^[0-9a-f]{8}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function parseId(text: string | undefined): number | null {
  if (!text || !/^\d+$/.test(text)) return null
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : null
}

export function encodeLogCallback(cb: LogCallback): string {
  return `log:${cb.action}:${cb.ownerId}:${cb.token}`
}

export function parseLogCallback(data: string): LogCallback | null {
  const parts = data.split(":")
  if (parts.length !== 4 || parts[0] !== "log") return null

  const [, action, owner, token] = parts
  if (action !== "ok" && action !== "chg" && action !== "cxl") return null

  const ownerId = parseId(owner)
  if (ownerId === null || !TOKEN.test(token)) return null

  return { action, ownerId, token }
}

export function encodeDeleteCallback(cb: DeleteCallback): string {
  switch (cb.action) {
    case "one":
      return `del:one:${cb.ownerId}:${cb.itemId}`
    case "all":
      return `del:all:${cb.ownerId}:${cb.date}:${cb.token}`
    case "cxl":
      return `del:cxl:${cb.ownerId}`
  }
}

export function parseDeleteCallback(data: string): DeleteCallback | null {
  const parts = data.split(":")
  if (parts[0] !== "del") return null

  const ownerId = parseId(parts[2])
  if (ownerId === null) return null

  switch (parts[1]) {
    case "one": {
      if (parts.length !== 4) return null
      const itemId = parseId(parts[3])
      return itemId === null ? null : { action: "one", ownerId, itemId }
    }
    case "all": {
      if (parts.length !== 5 || !DATE.test(parts[3]) || !TOKEN.test(parts[4])) return null
      return { action: "all", ownerId, date: parts[3], token: parts[4] }
    }
    case "cxl":
      return parts.length === 3 ? { action: "cxl", ownerId } : null
    default:
      return null
  }
}

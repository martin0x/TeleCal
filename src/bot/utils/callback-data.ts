// src/bot/utils/callback-data.ts
// Payload formats for the /log, /delete and /foods buttons. Every button
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

export type FoodsCallback =
  | { action: "add"; ownerId: number }
  | { action: "save"; ownerId: number; token: string }
  | { action: "cxl"; ownerId: number; token: string }
  | { action: "tog"; ownerId: number; index: number; token: string }
  | { action: "log"; ownerId: number; logId: number }

export function encodeFoodsCallback(cb: FoodsCallback): string {
  switch (cb.action) {
    case "add":
      return `foods:add:${cb.ownerId}`
    case "save":
      return `foods:save:${cb.ownerId}:${cb.token}`
    case "cxl":
      return `foods:cxl:${cb.ownerId}:${cb.token}`
    case "tog":
      return `foods:tog:${cb.ownerId}:${cb.index}:${cb.token}`
    case "log":
      return `foods:log:${cb.ownerId}:${cb.logId}`
  }
}

export function parseFoodsCallback(data: string): FoodsCallback | null {
  const parts = data.split(":")
  if (parts[0] !== "foods") return null

  const ownerId = parseId(parts[2])
  if (ownerId === null) return null

  switch (parts[1]) {
    case "add":
      return parts.length === 3 ? { action: "add", ownerId } : null
    case "save":
    case "cxl": {
      if (parts.length !== 4 || !TOKEN.test(parts[3])) return null
      return { action: parts[1] as "save" | "cxl", ownerId, token: parts[3] }
    }
    case "tog": {
      if (parts.length !== 5 || !TOKEN.test(parts[4])) return null
      const index = parseId(parts[3])
      return index === null ? null : { action: "tog", ownerId, index, token: parts[4] }
    }
    case "log": {
      if (parts.length !== 4) return null
      const logId = parseId(parts[3])
      return logId === null ? null : { action: "log", ownerId, logId }
    }
    default:
      return null
  }
}

// src/bot/utils/callback-data.test.ts
import { describe, test, expect } from "bun:test"
import {
  encodeLogCallback,
  parseLogCallback,
  encodeDeleteCallback,
  parseDeleteCallback,
  LogCallback,
  DeleteCallback,
} from "./callback-data"

// The largest integer a JS number holds exactly. Real Telegram ids are shorter,
// so this is the worst case for the 64-byte limit.
const BIG_ID = Number.MAX_SAFE_INTEGER

describe("log callback data", () => {
  test("round-trips every action", () => {
    for (const action of ["ok", "chg", "cxl"] as const) {
      const cb: LogCallback = { action, ownerId: 42, token: "abcd1234" }
      expect(parseLogCallback(encodeLogCallback(cb))).toEqual(cb)
    }
  })

  test("encodes to the documented format", () => {
    expect(encodeLogCallback({ action: "ok", ownerId: 42, token: "abcd1234" })).toBe("log:ok:42:abcd1234")
  })

  test("rejects malformed data", () => {
    for (const data of [
      "log:ok:42",
      "log:ok:42:abcd1234:extra",
      "log:yes:42:abcd1234",
      "log:ok:abc:abcd1234",
      "log:ok:-1:abcd1234",
      "log:ok:42:ABCD1234",
      "log:ok:42:abc",
      "settings:provider",
      "",
    ]) {
      expect(parseLogCallback(data)).toBeNull()
    }
  })

  test("stays within Telegram's 64-byte limit", () => {
    const data = encodeLogCallback({ action: "cxl", ownerId: BIG_ID, token: "abcd1234" })
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  })
})

describe("delete callback data", () => {
  const cases: DeleteCallback[] = [
    { action: "one", ownerId: 42, itemId: 7 },
    { action: "all", ownerId: 42, date: "2026-09-25", token: "abcd1234" },
    { action: "cxl", ownerId: 42 },
  ]

  test("round-trips every action", () => {
    for (const cb of cases) {
      expect(parseDeleteCallback(encodeDeleteCallback(cb))).toEqual(cb)
    }
  })

  test("encodes to the documented formats", () => {
    expect(cases.map((cb) => encodeDeleteCallback(cb))).toEqual([
      "del:one:42:7",
      "del:all:42:2026-09-25:abcd1234",
      "del:cxl:42",
    ])
  })

  test("rejects malformed data", () => {
    for (const data of [
      "del:one:42",
      "del:one:42:x",
      "del:all:42:2026-9-25:abcd1234",
      "del:all:42:2026-09-25",
      "del:cxl:42:7",
      "del:zap:42",
      "del:one:abc:7",
      "log:ok:42:abcd1234",
      "",
    ]) {
      expect(parseDeleteCallback(data)).toBeNull()
    }
  })

  test("stays within Telegram's 64-byte limit", () => {
    const data = encodeDeleteCallback({ action: "all", ownerId: BIG_ID, date: "2026-09-25", token: "abcd1234" })
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  })
})

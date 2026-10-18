// src/web/auth.test.ts
import { describe, test, expect } from "bun:test"
import { validateInitData, extractAuthHeader } from "./auth"
import { createValidInitData } from "./test-helpers"

const TEST_BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

describe("validateInitData", () => {
  test("validates correct initData", () => {
    const user = { id: 123456789, first_name: "John", username: "johndoe" }
    const initData = createValidInitData(user, TEST_BOT_TOKEN)

    const result = validateInitData(initData, TEST_BOT_TOKEN)

    expect(result).not.toBeNull()
    expect(result?.id).toBe(123456789)
    expect(result?.first_name).toBe("John")
    expect(result?.username).toBe("johndoe")
  })

  test("rejects invalid hash", () => {
    const user = { id: 123456789, first_name: "John" }
    const initData = createValidInitData(user, TEST_BOT_TOKEN)
    const tamperedData = initData.replace(/hash=[^&]+/, "hash=invalid_hash")

    const result = validateInitData(tamperedData, TEST_BOT_TOKEN)

    expect(result).toBeNull()
  })

  test("rejects wrong bot token", () => {
    const user = { id: 123456789, first_name: "John" }
    const initData = createValidInitData(user, TEST_BOT_TOKEN)

    const result = validateInitData(initData, "wrong_token")

    expect(result).toBeNull()
  })

  test("rejects empty initData", () => {
    const result = validateInitData("", TEST_BOT_TOKEN)
    expect(result).toBeNull()
  })

  test("rejects initData without hash", () => {
    const params = new URLSearchParams()
    params.set("user", JSON.stringify({ id: 123 }))
    params.set("auth_date", Math.floor(Date.now() / 1000).toString())

    const result = validateInitData(params.toString(), TEST_BOT_TOKEN)

    expect(result).toBeNull()
  })

  test("rejects initData without user", () => {
    const params = new URLSearchParams()
    params.set("auth_date", Math.floor(Date.now() / 1000).toString())
    params.set("hash", "somehash")

    const result = validateInitData(params.toString(), TEST_BOT_TOKEN)

    expect(result).toBeNull()
  })
})

describe("extractAuthHeader", () => {
  test("extracts initData from valid header", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "tg-init-data abc123" },
    })

    const result = extractAuthHeader(request)

    expect(result).toBe("abc123")
  })

  test("returns null for missing header", () => {
    const request = new Request("http://localhost/api/test")

    const result = extractAuthHeader(request)

    expect(result).toBeNull()
  })

  test("returns null for wrong prefix", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer abc123" },
    })

    const result = extractAuthHeader(request)

    expect(result).toBeNull()
  })
})

// src/utils/format.test.ts
import { describe, test, expect } from "bun:test"
import { formatUsd, formatTokens } from "./format"

describe("formatUsd", () => {
  test("uses two decimals at or above one cent", () => {
    expect(formatUsd(1.844)).toBe("$1.84")
    expect(formatUsd(0.01)).toBe("$0.01")
  })

  test("uses four decimals below one cent, so small spend is not rendered as zero", () => {
    expect(formatUsd(0.0043)).toBe("$0.0043")
    expect(formatUsd(0.000078)).toBe("$0.0001")
  })

  test("renders a true zero plainly", () => {
    expect(formatUsd(0)).toBe("$0.00")
  })
})

describe("formatTokens", () => {
  test("groups thousands below 10k", () => {
    expect(formatTokens(21300)).toBe("21,300")
    expect(formatTokens(950)).toBe("950")
  })

  test("abbreviates at and above 100k", () => {
    expect(formatTokens(186200)).toBe("186.2k")
    expect(formatTokens(1500000)).toBe("1500.0k")
  })
})

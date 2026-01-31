// src/utils/dates.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  getToday,
  formatDate,
  parseDate,
  getDateRange,
  formatDateForDisplay,
} from "./dates"

describe("dates utility", () => {
  test("getToday returns YYYY-MM-DD format", () => {
    const today = getToday()
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("formatDate converts Date to YYYY-MM-DD", () => {
    const date = new Date("2026-01-31T12:00:00Z")
    expect(formatDate(date)).toBe("2026-01-31")
  })

  test("parseDate converts YYYY-MM-DD to Date", () => {
    const date = parseDate("2026-01-31")
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(0) // January is 0
    expect(date.getDate()).toBe(31)
  })

  test("getDateRange returns correct number of days", () => {
    const range = getDateRange(7, "2026-01-31")
    expect(range.length).toBe(7)
    expect(range[0]).toBe("2026-01-25")
    expect(range[6]).toBe("2026-01-31")
  })

  test("getDateRange for 30 days", () => {
    const range = getDateRange(30, "2026-01-31")
    expect(range.length).toBe(30)
    expect(range[0]).toBe("2026-01-02")
    expect(range[29]).toBe("2026-01-31")
  })

  test("formatDateForDisplay formats nicely", () => {
    const display = formatDateForDisplay("2026-01-31")
    expect(display).toContain("Jan")
    expect(display).toContain("31")
  })
})

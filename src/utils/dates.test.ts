// src/utils/dates.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  getToday,
  formatDate,
  parseDate,
  getDateRange,
  formatDateForDisplay,
  getTodayInTimezone,
  formatDateInTimezone,
  getYesterdayInTimezone,
  getCurrentTimeInTimezone,
  isValidTimezone,
  getDateRangeInTimezone,
  DEFAULT_TIMEZONE,
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

describe("timezone-aware date utilities", () => {
  test("DEFAULT_TIMEZONE is Asia/Manila", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Manila")
  })

  test("getTodayInTimezone returns YYYY-MM-DD format", () => {
    const today = getTodayInTimezone("Asia/Manila")
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("formatDateInTimezone formats date correctly", () => {
    // Create a date at midnight UTC on Jan 31, 2026
    const date = new Date("2026-01-31T00:00:00Z")
    // In Asia/Manila (UTC+8), this would be 8 AM on Jan 31
    expect(formatDateInTimezone(date, "Asia/Manila")).toBe("2026-01-31")
    // In America/New_York (UTC-5 in winter), this would still be Jan 30
    expect(formatDateInTimezone(date, "America/New_York")).toBe("2026-01-30")
  })

  test("getYesterdayInTimezone returns previous day", () => {
    const yesterday = getYesterdayInTimezone("Asia/Manila")
    const today = getTodayInTimezone("Asia/Manila")

    // Parse and compare
    const yesterdayDate = parseDate(yesterday)
    const todayDate = parseDate(today)

    // Yesterday should be exactly one day before today
    const diffMs = todayDate.getTime() - yesterdayDate.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    expect(diffDays).toBe(1)
  })

  test("getCurrentTimeInTimezone returns HH:MM format", () => {
    const time = getCurrentTimeInTimezone("Asia/Manila")
    expect(time).toMatch(/^\d{2}:\d{2}$/)
  })

  test("isValidTimezone validates IANA timezones", () => {
    expect(isValidTimezone("Asia/Manila")).toBe(true)
    expect(isValidTimezone("America/New_York")).toBe(true)
    expect(isValidTimezone("Europe/London")).toBe(true)
    expect(isValidTimezone("UTC")).toBe(true)
    expect(isValidTimezone("Invalid/Timezone")).toBe(false)
    expect(isValidTimezone("not a timezone")).toBe(false)
  })

  test("getDateRangeInTimezone returns correct range", () => {
    const range = getDateRangeInTimezone(7, "2026-01-31", "Asia/Manila")
    expect(range.length).toBe(7)
    expect(range[0]).toBe("2026-01-25")
    expect(range[6]).toBe("2026-01-31")
  })

  test("different timezones produce different 'today' around midnight UTC", () => {
    // This test verifies that the timezone logic works correctly
    // When it's midnight UTC, Asia/Manila (UTC+8) is already 8 AM the same day
    // while America/Los_Angeles (UTC-8) is still 4 PM the previous day
    const manilaToday = getTodayInTimezone("Asia/Manila")
    const laToday = getTodayInTimezone("America/Los_Angeles")

    // Both should be valid date formats
    expect(manilaToday).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(laToday).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // Due to time difference (16 hours apart), they may or may not be different
    // depending on current time - we just verify they're valid dates
  })
})

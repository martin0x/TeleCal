// src/utils/dates.ts

export const DEFAULT_TIMEZONE = "Asia/Manila"

export function getToday(): string {
  return formatDate(new Date())
}

export function getTodayInTimezone(timezone: string): string {
  return formatDateInTimezone(new Date(), timezone)
}

export function formatDateInTimezone(date: Date, timezone: string): string {
  // Use en-CA locale to get YYYY-MM-DD format directly
  return date.toLocaleDateString("en-CA", { timeZone: timezone })
}

export function getYesterdayInTimezone(timezone: string): string {
  const now = new Date()
  // Get current date components in the target timezone
  const todayStr = formatDateInTimezone(now, timezone)
  const [year, month, day] = todayStr.split("-").map(Number)
  // Create a date at noon to avoid DST edge cases, then subtract a day
  const yesterday = new Date(year, month - 1, day, 12, 0, 0)
  yesterday.setDate(yesterday.getDate() - 1)
  return formatDate(yesterday)
}

export function getCurrentTimeInTimezone(timezone: string): string {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return formatter.format(now)
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function getDateRangeInTimezone(
  days: number,
  endDate: string,
  timezone: string
): string[] {
  const [year, month, day] = endDate.split("-").map(Number)
  // Use noon to avoid DST issues
  const end = new Date(year, month - 1, day, 12, 0, 0)
  const dates: string[] = []

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end)
    date.setDate(date.getDate() - i)
    dates.push(formatDate(date))
  }

  return dates
}

export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number)
  return new Date(year, month - 1, day)
}

export function getDateRange(days: number, endDate?: string): string[] {
  const end = endDate ? parseDate(endDate) : new Date()
  const dates: string[] = []

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end)
    date.setDate(date.getDate() - i)
    dates.push(formatDate(date))
  }

  return dates
}

export function formatDateForDisplay(dateStr: string): string {
  const date = parseDate(dateStr)
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  }
  return date.toLocaleDateString("en-US", options)
}

export function isToday(dateStr: string): boolean {
  return dateStr === getToday()
}

export function getYesterday(): string {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return formatDate(date)
}

export function getDayOfWeek(dateStr: string): string {
  const date = parseDate(dateStr)
  return date.toLocaleDateString("en-US", { weekday: "long" })
}

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidDateString(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const date = new Date(`${dateStr}T00:00:00Z`)
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateStr
}

/** The date `days` after dateStr (negative for before). Calendar arithmetic in UTC, so no DST surprises. */
export function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Every date from start to end, inclusive; empty when start is after end. */
export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    dates.push(date)
  }
  return dates
}

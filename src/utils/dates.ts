// src/utils/dates.ts

export function getToday(): string {
  return formatDate(new Date())
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

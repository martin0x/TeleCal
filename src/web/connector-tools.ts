// src/web/connector-tools.ts
// The data behind the Claude connector's MCP tools (src/web/mcp.ts), kept
// apart from the protocol so each tool's output is testable on its own.
// Read-only: nothing here writes to the database.
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { getTodayInTimezone, isValidDateString, addDays, getDatesBetween, DEFAULT_TIMEZONE } from "../utils/dates"
import { sumTotals } from "../utils/format"

/** Longest range a single call may ask for. */
export const MAX_RANGE_DAYS = 366
/** Range when the caller gives no start date. */
export const DEFAULT_RANGE_DAYS = 30
const TOP_FOODS_LIMIT = 10

/** Bad input from the caller; its message goes back to Claude as the tool error. */
export class ToolInputError extends Error {}

export interface ConnectorToolsDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
}

export interface RangeInput {
  start_date?: string
  end_date?: string
}

export function createConnectorTools(deps: ConnectorToolsDeps) {
  const { usersRepo, foodLogsRepo } = deps

  function userContext(telegramId: number) {
    const user = usersRepo.findById(telegramId)
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE
    return {
      timezone,
      today: getTodayInTimezone(timezone),
      calorieGoal: user?.daily_goal ?? null,
      proteinGoal: user?.daily_protein_goal ?? null,
    }
  }

  function checkDate(name: string, value: string): string {
    if (!isValidDateString(value)) {
      throw new ToolInputError(`${name} must be a date in YYYY-MM-DD form, got "${value}"`)
    }
    return value
  }

  /** end defaults to the user's today, start to DEFAULT_RANGE_DAYS before end. */
  function resolveRange(today: string, input: RangeInput): { start: string; end: string; dates: string[] } {
    const end = input.end_date ? checkDate("end_date", input.end_date) : today
    const start = input.start_date ? checkDate("start_date", input.start_date) : addDays(end, -(DEFAULT_RANGE_DAYS - 1))
    if (start > end) {
      throw new ToolInputError(`start_date ${start} is after end_date ${end}`)
    }
    if (addDays(start, MAX_RANGE_DAYS - 1) < end) {
      throw new ToolInputError(`The range can be at most ${MAX_RANGE_DAYS} days; split it into several calls`)
    }
    return { start, end, dates: getDatesBetween(start, end) }
  }

  return {
    getProfile(telegramId: number) {
      const ctx = userContext(telegramId)
      const logged = foodLogsRepo.getLoggedDateRange(telegramId)
      return {
        today: ctx.today,
        timezone: ctx.timezone,
        daily_calorie_goal: ctx.calorieGoal,
        daily_protein_goal_g: ctx.proteinGoal,
        first_logged_date: logged.first,
        last_logged_date: logged.last,
      }
    },

    getDailyTotals(telegramId: number, input: RangeInput) {
      const ctx = userContext(telegramId)
      const { start, end, dates } = resolveRange(ctx.today, input)
      const totals = foodLogsRepo.getDailyTotals(telegramId, start, end)
      return {
        start_date: start,
        end_date: end,
        daily_calorie_goal: ctx.calorieGoal,
        daily_protein_goal_g: ctx.proteinGoal,
        // Every date, so a day with nothing logged reads as logged: false, not as a zero-calorie day.
        days: dates.map((date) => ({
          date,
          logged: date in totals,
          calories: totals[date]?.calories ?? 0,
          protein_g: totals[date]?.protein ?? 0,
        })),
      }
    },

    getDay(telegramId: number, date: string) {
      checkDate("date", date)
      const items = foodLogsRepo.getByDate(telegramId, date).flatMap((log) =>
        log.items.map((item) => ({
          description: item.description,
          calories: item.calories,
          protein_g: item.protein_g ?? null,
        }))
      )
      const totals = sumTotals(items)
      return { date, calories: totals.calories, protein_g: totals.protein, items }
    },

    getSummary(telegramId: number, input: RangeInput) {
      const ctx = userContext(telegramId)
      const { start, end, dates } = resolveRange(ctx.today, input)
      const totals = foodLogsRepo.getDailyTotals(telegramId, start, end)
      const logged = dates.filter((date) => date in totals).map((date) => ({ date, ...totals[date] }))

      const average = (values: number[]) =>
        values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
      const byCalories = [...logged].sort((a, b) => a.calories - b.calories)
      const extreme = (day: (typeof logged)[number] | undefined) =>
        day ? { date: day.date, calories: day.calories } : null

      return {
        start_date: start,
        end_date: end,
        days_in_range: dates.length,
        days_logged: logged.length,
        // Over logged days only: an unlogged day is missing data, not a zero.
        average_calories: average(logged.map((d) => d.calories)),
        average_protein_g: average(logged.map((d) => d.protein)),
        daily_calorie_goal: ctx.calorieGoal,
        days_over_calorie_goal: ctx.calorieGoal === null ? null : logged.filter((d) => d.calories > ctx.calorieGoal!).length,
        daily_protein_goal_g: ctx.proteinGoal,
        days_meeting_protein_goal:
          ctx.proteinGoal === null ? null : logged.filter((d) => d.protein >= ctx.proteinGoal!).length,
        lowest_day: extreme(byCalories[0]),
        highest_day: extreme(byCalories[byCalories.length - 1]),
        top_foods: foodLogsRepo.getTopFoods(telegramId, start, end, TOP_FOODS_LIMIT),
      }
    },
  }
}

export type ConnectorTools = ReturnType<typeof createConnectorTools>

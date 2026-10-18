// src/bot/commands/admin-announce.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { AnnouncementsRepository } from "../../db/repositories/announcements"
import { announcePrivacy, PRIVACY_ANNOUNCEMENT, privacyNoticeText } from "./admin"

const ADMIN = 7
let allowedUsersRepo: AllowedUsersRepository
let announcementsRepo: AnnouncementsRepository
let replies: string[]
let delivered: { id: number; text: string }[]

const reply = async (text: string) => {
  replies.push(text)
}

function deps() {
  return {
    allowedUsersRepo,
    announcementsRepo,
    adminIds: [ADMIN],
    send: async (id: number, text: string) => {
      delivered.push({ id, text })
    },
    sleep: async () => {},
  }
}

beforeEach(() => {
  const db = createTestDb()
  allowedUsersRepo = new AllowedUsersRepository(db)
  announcementsRepo = new AnnouncementsRepository(db)
  allowedUsersRepo.add(101, ADMIN)
  allowedUsersRepo.add(102, ADMIN)
  replies = []
  delivered = []
})

describe("privacyNoticeText", () => {
  test("names PostHog, says what it receives, and links to the privacy section", () => {
    const text = privacyNoticeText("https://telecal.example")
    expect(text).toContain("PostHog")
    expect(text).toContain("error reports")
    expect(text).toContain("AI's reply")
    expect(text).toContain("never your name or username")
    expect(text).toContain("https://telecal.example/#privacy")
  })

  test("tells users they can keep their meal text out in /settings", () => {
    expect(privacyNoticeText("https://telecal.example")).toContain("/settings → Meal Text Sharing")
  })
})

describe("announcePrivacy", () => {
  test("without confirm, previews the message and the head count but sends nothing", async () => {
    await announcePrivacy(deps(), undefined, "https://telecal.example", reply)

    expect(delivered).toEqual([])
    expect(replies.join("\n")).toContain(privacyNoticeText("https://telecal.example"))
    expect(replies.join("\n")).toContain("3 users") // two allowlisted plus the admin
    expect(replies.join("\n")).toContain("/admin announce-privacy confirm")
  })

  test("confirm sends to allowlisted users and admins, then reports", async () => {
    await announcePrivacy(deps(), "confirm", "https://telecal.example", reply)

    expect(delivered.map((d) => d.id).sort((a, b) => a - b)).toEqual([7, 101, 102])
    expect(delivered[0].text).toBe(privacyNoticeText("https://telecal.example"))
    expect(replies.at(-1)).toBe("Privacy notice sent to 3 users.")
    expect(announcementsRepo.countSent(PRIVACY_ANNOUNCEMENT)).toBe(3)
  })

  test("a second confirm sends nothing", async () => {
    await announcePrivacy(deps(), "confirm", "https://telecal.example", reply)
    delivered = []

    await announcePrivacy(deps(), "confirm", "https://telecal.example", reply)

    expect(delivered).toEqual([])
    expect(replies.at(-1)).toBe("Everyone has already received the privacy notice (3 users).")
  })

  test("reports users it couldn't reach, so a later run can retry them", async () => {
    const d = deps()
    d.send = async (id: number, text: string) => {
      if (id === 102) throw new Error("Forbidden: bot was blocked by the user")
      delivered.push({ id, text })
    }
    const errorLog = console.error
    console.error = () => {}

    await announcePrivacy(d, "confirm", "https://telecal.example", reply)

    console.error = errorLog
    expect(replies.at(-1)).toBe(
      "Privacy notice sent to 2 users. Couldn't reach 1:\n• 102: Forbidden: bot was blocked by the user\nRun /admin announce-privacy confirm again to retry them."
    )
  })
})

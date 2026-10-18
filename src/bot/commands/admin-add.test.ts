// src/bot/commands/admin-add.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../../db/test-helpers"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import { FakeAnalytics } from "../../analytics/test-helpers"
import { addToAllowlist } from "./admin"

const ADMIN = 7
let allowedUsersRepo: AllowedUsersRepository
let accessRequestsRepo: AccessRequestsRepository
let analytics: FakeAnalytics

beforeEach(() => {
  const db = createTestDb()
  allowedUsersRepo = new AllowedUsersRepository(db)
  accessRequestsRepo = new AccessRequestsRepository(db)
  analytics = new FakeAnalytics()
})

describe("addToAllowlist", () => {
  test("allowlists the user and closes their open request", () => {
    accessRequestsRepo.request(42, "maria", "Maria")

    addToAllowlist({ allowedUsersRepo, accessRequestsRepo, analytics }, 42, ADMIN)

    expect(allowedUsersRepo.isAllowed(42)).toBe(true)
    expect(accessRequestsRepo.find(42)?.status).toBe("approved")
  })

  test("closing an open request counts as an approval in the funnel", () => {
    accessRequestsRepo.request(42, "maria", "Maria")

    addToAllowlist({ allowedUsersRepo, accessRequestsRepo, analytics }, 42, ADMIN)

    expect(analytics.events).toEqual([{ telegramId: 42, event: "access_approved", properties: { via: "admin_add" } }])
  })

  test("adding someone who never requested sends nothing", () => {
    addToAllowlist({ allowedUsersRepo, accessRequestsRepo, analytics }, 42, ADMIN)

    expect(analytics.events).toEqual([])
  })
})

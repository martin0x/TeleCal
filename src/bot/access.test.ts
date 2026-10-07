// src/bot/access.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Api, Context } from "grammy"
import { createTestDb } from "../db/test-helpers"
import { AccessRequestsRepository } from "../db/repositories/access-requests"
import { AllowedUsersRepository } from "../db/repositories/allowed-users"
import {
  APPROVED_MESSAGE,
  DECLINED_MESSAGE,
  createAccessDecisionHandler,
  createAdminNotifier,
  decisionKeyboard,
  formatAccessRequest,
  parseDecision,
  requestAccessKeyboard,
  sendPendingRequests,
} from "./access"

const USER = 42
const ADMIN = 1
let accessRequestsRepo: AccessRequestsRepository
let allowedUsersRepo: AllowedUsersRepository

beforeEach(() => {
  const db = createTestDb()
  accessRequestsRepo = new AccessRequestsRepository(db)
  allowedUsersRepo = new AllowedUsersRepository(db)
})

function decisionCtx(data: string, from: { id: number; username?: string; first_name: string }) {
  return {
    from,
    chat: { id: from.id, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    api: { sendMessage: mock(() => Promise.resolve({})) },
  }
}

const handler = () => createAccessDecisionHandler({ accessRequestsRepo, allowedUsersRepo, adminIds: [ADMIN] })
const admin = { id: ADMIN, username: "boss", first_name: "Ray" }

describe("keyboards and parsing", () => {
  test("request keyboard has one Request access button", () => {
    expect(requestAccessKeyboard().inline_keyboard).toEqual([[{ text: "Request access", callback_data: "access:req" }]])
  })

  test("decision keyboard round-trips through parseDecision", () => {
    const [[approve, decline]] = decisionKeyboard(USER).inline_keyboard as { text: string; callback_data: string }[][]
    expect(approve.text).toBe("Approve")
    expect(decline.text).toBe("Decline")
    expect(parseDecision(approve.callback_data)).toEqual({ status: "approved", telegramId: USER })
    expect(parseDecision(decline.callback_data)).toEqual({ status: "declined", telegramId: USER })
  })

  test("parseDecision rejects anything else", () => {
    for (const data of [undefined, "access:req", "access:ok:", "access:ok:12x", "log:ok:1"]) {
      expect(parseDecision(data)).toBeNull()
    }
  })
})

describe("formatAccessRequest", () => {
  test("includes name, handle and id", () => {
    expect(formatAccessRequest({ telegram_id: USER, username: "maria", first_name: "Maria" })).toBe(
      "Access request: Maria (@maria), id 42"
    )
  })

  test("copes with missing names", () => {
    expect(formatAccessRequest({ telegram_id: USER, username: null, first_name: null })).toBe("Access request: Unknown, id 42")
  })
})

describe("createAdminNotifier", () => {
  test("messages every admin with decision buttons and survives a failed send", async () => {
    accessRequestsRepo.request(USER, "maria", "Maria")
    const sendMessage = mock((chatId: number) => (chatId === 2 ? Promise.reject(new Error("blocked")) : Promise.resolve({})))
    const notify = createAdminNotifier({ sendMessage } as unknown as Pick<Api, "sendMessage">, [ADMIN, 2, 3])

    await notify(accessRequestsRepo.find(USER)!)

    expect(sendMessage).toHaveBeenCalledTimes(3)
    const [chatId, text, options] = sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: unknown }]
    expect(chatId).toBe(ADMIN)
    expect(text).toBe("Access request: Maria (@maria), id 42")
    expect(options.reply_markup).toEqual(decisionKeyboard(USER))
  })
})

describe("sendPendingRequests", () => {
  test("says so when there are none", async () => {
    const reply = mock(() => Promise.resolve())
    await sendPendingRequests(accessRequestsRepo, reply)
    expect(reply).toHaveBeenCalledWith("No pending requests.")
  })

  test("sends one message with buttons per pending request", async () => {
    accessRequestsRepo.request(USER, "maria", "Maria")
    accessRequestsRepo.request(43, "juan", "Juan")
    const reply = mock(() => Promise.resolve())
    await sendPendingRequests(accessRequestsRepo, reply)
    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[0]).toEqual(["Access request: Maria (@maria), id 42", decisionKeyboard(USER)] as never)
  })
})

describe("createAccessDecisionHandler", () => {
  beforeEach(() => {
    accessRequestsRepo.request(USER, "maria", "Maria")
  })

  test("approve allowlists the user, edits the admin message and tells the user", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, admin)
    await handler()(ctx as unknown as Context)

    expect(allowedUsersRepo.isAllowed(USER)).toBe(true)
    expect(accessRequestsRepo.find(USER)?.status).toBe("approved")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Access request: Maria (@maria), id 42\n\nApproved by @boss", undefined)
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(USER, APPROVED_MESSAGE)
  })

  test("decline does not allowlist and sends the decline message", async () => {
    const ctx = decisionCtx(`access:no:${USER}`, admin)
    await handler()(ctx as unknown as Context)

    expect(allowedUsersRepo.isAllowed(USER)).toBe(false)
    expect(accessRequestsRepo.find(USER)?.status).toBe("declined")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Access request: Maria (@maria), id 42\n\nDeclined by @boss", undefined)
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(USER, DECLINED_MESSAGE)
  })

  test("a non-admin is refused and nothing changes", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, { id: 77, first_name: "Eve" })
    await handler()(ctx as unknown as Context)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Admins only." })
    expect(allowedUsersRepo.isAllowed(USER)).toBe(false)
    expect(accessRequestsRepo.find(USER)?.status).toBe("pending")
  })

  test("a second decision answers Already and sends nothing", async () => {
    await handler()(decisionCtx(`access:ok:${USER}`, admin) as unknown as Context)
    const second = decisionCtx(`access:no:${USER}`, admin)
    await handler()(second as unknown as Context)

    expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already approved." })
    expect(second.api.sendMessage).not.toHaveBeenCalled()
    expect(accessRequestsRepo.find(USER)?.status).toBe("approved")
  })

  test("an allowlisted user pressing an old Request access button is told they're in", async () => {
    const ctx = decisionCtx("access:req", { id: USER, first_name: "Maria" })
    await handler()(ctx as unknown as Context)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "You already have access." })
  })

  test("still succeeds when the user can't be messaged", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, admin)
    ctx.api.sendMessage = mock(() => Promise.reject(new Error("bot was blocked by the user")))
    await handler()(ctx as unknown as Context)
    expect(allowedUsersRepo.isAllowed(USER)).toBe(true)
  })
})

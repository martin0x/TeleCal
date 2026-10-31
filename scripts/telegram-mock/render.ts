// Renders the landing page's three phone screenshots as Telegram for iOS
// screens. Every bot message comes from the bot's own formatters and the
// charts screen is the real Mini App on stub data, so a wording change shows
// up on the next render. macOS only (Chrome). From the repo root:
//   bun run scripts/telegram-mock/render.ts && bash scripts/build-landing-assets.sh
// Writes scripts/screenshots/shot-{log,today,charts}.png (gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// config.ts throws without a token. Nothing here talks to Telegram.
process.env.TELEGRAM_BOT_TOKEN ||= "mock"
const { formatItemsSummary, sumTotals, escapeHtml } = await import("../../src/utils/format")
const { formatDateForDisplay } = await import("../../src/utils/dates")
const { buildTodayMessage } = await import("../../src/bot/commands/today")
const { buildLogConfirmKeyboard } = await import("../../src/bot/commands/log")

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const HERE = import.meta.dir
const OUT = join(HERE, "../screenshots")
const PAGES = join(OUT, ".mock")
mkdirSync(PAGES, { recursive: true })

// A Saturday. Lunch is the /log screen; /today is the same day a few minutes on.
const TODAY = "2026-10-31"
const BREAKFAST = [
  { description: "Scrambled eggs (2)", calories: 180, protein_g: 12, emoji: "🍳" },
  { description: "Pandesal (2)", calories: 240, protein_g: 7, emoji: "🥖" },
  { description: "Black coffee", calories: 5, protein_g: 0, emoji: "☕" },
]
// The same numbers as scripts/og.html.
const LUNCH = [
  { description: "Chicken adobo (2 pcs)", calories: 420, protein_g: 38, emoji: "🍗" },
  { description: "Steamed rice (1 cup)", calories: 205, protein_g: 4, emoji: "🍚" },
]
const GOALS = { daily_goal: 2000, daily_protein_goal: 120 }

// ---------------------------------------------------------------- chat pieces

interface Message {
  from: "me" | "bot"
  body: string // HTML, ready for the bubble
  time: string
  edited?: boolean
  keyboard?: string[][]
}

/** A plain-text message: escaped, with /commands linked the way Telegram does. */
function plain(text: string): string {
  return escapeHtml(text).replace(/(^|\s)(\/[a-z_]+)/g, '$1<a>$2</a>')
}

/**
 * A parse_mode "HTML" message. Telegram draws a blockquote as its own block, so
 * the newlines around it only add blank lines beyond the first.
 */
function html(text: string): string {
  const lines = (n: number) => Math.max(0, n - 1) * 22 + 4
  return text
    .replace(/(\n*)<blockquote>/g, (_, nl: string) => `<blockquote style="margin-top:${lines(nl.length)}px">`)
    .replace(/<\/blockquote>(\n*)/g, (_, nl: string) => `</blockquote><div style="height:${lines(nl.length)}px"></div>`)
}

function keyboardLabels(totals: { calories: number; protein: number }): string[][] {
  return buildLogConfirmKeyboard(1, { token: "mock", totals }).inline_keyboard.map((row) => row.map((b) => b.text))
}

const TICKS = '<svg width="16" height="10" viewBox="0 0 16 10"><path d="M1 5.2l3.1 3.1 6.5-6.8M7.2 7.6l.7.7 6.6-6.8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const TAIL = '<svg class="tail" viewBox="0 0 9 17"><path d="M9 0v17H1.4C.4 17-.1 15.9.6 15.2 3.9 12 5.9 8 6.2 0z"/></svg>'

function bubble(m: Message, sameAsPrevious: boolean): string {
  const label = `${m.edited ? "edited " : ""}${m.time}`
  // Room for the time on the last line; ~6.4px a character at 11.5px.
  const spacer = Math.ceil(label.length * 6.4) + (m.from === "me" ? 19 : 0) + 8
  const keyboard = m.keyboard
    ? `<div class="keyboard">${m.keyboard.map((row) => `<div class="krow">${row.map((t) => `<div class="btn">${escapeHtml(t)}</div>`).join("")}</div>`).join("")}</div>`
    : ""
  return `<div class="row ${m.from}${sameAsPrevious ? " same" : ""}">
    <div class="bubble">${m.body}<span class="spacer" style="width:${spacer}px"></span><span class="meta">${label}${m.from === "me" ? TICKS : ""}</span>${TAIL}</div>${keyboard}
  </div>`
}

const ICONS = {
  signal: '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" width="3" height="12" rx="1"/></svg>',
  wifi: '<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.3c2.3 0 4.4.9 6 2.4l1.2-1.2A10.3 10.3 0 0 0 8 .6 10.3 10.3 0 0 0 .8 3.5L2 4.7a8.6 8.6 0 0 1 6-2.4zm0 3.3c1.4 0 2.6.5 3.6 1.4L12.8 5.8A6.9 6.9 0 0 0 8 3.9a6.9 6.9 0 0 0-4.8 1.9L4.4 7c1-.9 2.2-1.4 3.6-1.4zM8 8.9c-.6 0-1.1.2-1.5.6L8 11.1l1.5-1.6c-.4-.4-.9-.6-1.5-.6z"/></svg>',
  battery: '<svg width="27" height="13" viewBox="0 0 27 13" fill="currentColor"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".38"/><rect x="2" y="2" width="16" height="9" rx="2.2"/><path d="M25 4.4v4.2c.8-.3 1.4-1.1 1.4-2.1S25.8 4.7 25 4.4z" opacity=".4"/></svg>',
  back: '<svg width="13" height="21" viewBox="0 0 13 21"><path d="M11 2 2.5 10.5 11 19" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  menu: '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M1.5 1.5h12M1.5 6.5h12M1.5 11.5h12"/></svg>',
  clip: '<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/></svg>',
  mic: '<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="8.5" y="2.5" width="7" height="12.5" rx="3.5"/><path d="M5.2 11.5a6.8 6.8 0 0 0 13.6 0M12 18.3V21.5"/></svg>',
  more: '<svg width="16" height="4" viewBox="0 0 16 4" fill="#000"><circle cx="2" cy="2" r="1.8"/><circle cx="8" cy="2" r="1.8"/><circle cx="14" cy="2" r="1.8"/></svg>',
}
const AVATAR = readFileSync(join(HERE, "../../src/web/public/favicon.svg"), "utf8").replace('rx="7"', 'rx="0"')
const STATUS = `<div class="status"><span>12:48</span><span class="icons">${ICONS.signal}${ICONS.wifi}${ICONS.battery}</span></div><div class="island"></div>`

function page(bodyClass: string, inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../../telegram-mock/telegram.css"></head><body class="${bodyClass}">${inner}</body></html>`
}

function chatPage(messages: Message[]): string {
  const rows = messages.map((m, i) => bubble(m, i > 0 && messages[i - 1].from === m.from)).join("")
  return page("", `
    <div class="top">${STATUS}
      <div class="nav"><div class="back">${ICONS.back}Chats</div><div class="title"><b>TeleCal</b><span>bot</span></div><div class="avatar-wrap"><div class="avatar">${AVATAR}</div></div></div>
    </div>
    <div class="chat"><div class="pill">Today</div>${rows}</div>
    <div class="input"><div class="menu">${ICONS.menu}Menu</div><div class="ic">${ICONS.clip}</div><div class="field">Message</div><div class="ic">${ICONS.mic}</div><div class="home"></div></div>`)
}

// ---------------------------------------------------------------- the screens

const day = formatDateForDisplay(TODAY)
const lunchTotals = sumTotals(LUNCH)

const logScreen = chatPage([
  { from: "me", body: plain("/log 2 scrambled eggs, 2 pandesal, black coffee"), time: "7:52" },
  { from: "bot", body: html(`✅ Logged to ${day}:\n\n${formatItemsSummary(BREAKFAST)}`), time: "7:52", edited: true },
  { from: "me", body: plain("/log chicken adobo with rice"), time: "12:40" },
  { from: "bot", body: plain("How many pieces of chicken, and about how much rice?"), time: "12:40" },
  { from: "me", body: plain("2 pieces, 1 cup of rice"), time: "12:41" },
  {
    from: "bot",
    body: html(`Here's what I'll log for ${day}:\n\n${formatItemsSummary(LUNCH)}`),
    time: "12:41",
    keyboard: keyboardLabels(lunchTotals),
  },
])

const allToday = [...BREAKFAST, ...LUNCH]
const todayScreen = chatPage([
  { from: "bot", body: html(`✅ Logged to ${day}:\n\n${formatItemsSummary(LUNCH)}`), time: "12:41", edited: true },
  { from: "me", body: plain("/today"), time: "12:47" },
  {
    from: "bot",
    body: plain(buildTodayMessage({ date: TODAY, items: allToday as never, totals: sumTotals(allToday), dailyGoal: GOALS.daily_goal, proteinGoal: GOALS.daily_protein_goal })),
    time: "12:47",
    keyboard: [["📈 View Charts"]], // the label in src/bot/commands/today.ts
  },
])

// The real Mini App with the Telegram SDK and the API stubbed out.
const WEEK = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", TODAY]
const WEEK_CAL = [1840, 2120, 1760, 1950, 2280, 1890, sumTotals(allToday).calories]
const WEEK_PROTEIN = [96, 112, 88, 104, 121, 99, sumTotals(allToday).protein]
const FRIDAY = [
  { id: 1, description: "Tapsilog", calories: 720, protein_g: 44, emoji: "🍳" },
  { id: 2, description: "Iced latte (16 oz)", calories: 190, protein_g: 10, emoji: "☕" },
  { id: 3, description: "Beef pares", calories: 620, protein_g: 42, emoji: "🍜" },
  { id: 4, description: "Mango (1 medium)", calories: 100, protein_g: 1, emoji: "🥭" },
  { id: 5, description: "Banana cue (1 stick)", calories: 260, protein_g: 2, emoji: "🍌" },
]
const dayPayload = (date: string, items: typeof FRIDAY) => ({ date, total: sumTotals(items).calories, protein: sumTotals(items).protein, items })
const API: Record<string, unknown> = {
  "/api/user": { ...GOALS, username: null, analytics_id: null },
  "/api/today": dayPayload(TODAY, allToday.map((item, i) => ({ id: i + 1, ...item }))),
  "/api/stats?period=week": {
    start: WEEK[0],
    end: TODAY,
    daily: Object.fromEntries(WEEK.map((d, i) => [d, WEEK_CAL[i]])),
    dailyProtein: Object.fromEntries(WEEK.map((d, i) => [d, WEEK_PROTEIN[i]])),
  },
  "/api/day/2026-10-30": dayPayload("2026-10-30", FRIDAY),
}
// Telegram's Day theme with the violet accent, as the SDK would set it.
const THEME = { bg_color: "#ffffff", text_color: "#000000", hint_color: "#8e8e93", link_color: "#6d4aff", button_color: "#6d4aff", button_text_color: "#ffffff", secondary_bg_color: "#efeff4" }
const stub = `<script>
  for (const [k, v] of Object.entries(${JSON.stringify(THEME)})) document.documentElement.style.setProperty('--tg-theme-' + k.replace(/_/g, '-'), v);
  window.Telegram = { WebApp: { initData: '', ready() {}, expand() {} } };
  const API = ${JSON.stringify(API)};
  window.fetch = async (url) => new Response(JSON.stringify(API[url]), { status: url in API ? 200 : 404 });
</script>`
const app = readFileSync(join(HERE, "../../src/web/views/app.html"), "utf8")
  .replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', stub)
  .replace(/(<script src="[^"]*chart\.umd[^"]*"><\/script>)/, "$1<script>Chart.defaults.animation = false</script>")
  .replace("{{ANALYTICS}}", "")
  .replace("</body>", "<script>document.querySelector('[data-tab=week]').click(); setTimeout(() => loadDayLog('2026-10-30', 'week'), 100)</script></body>")
writeFileSync(join(PAGES, "app.html"), app)

const chartsScreen = page("app", `
  <div class="sheet">${STATUS}
    <div class="app-head"><div class="close">Close</div><div class="title"><b>TeleCal</b></div><div class="more"><span>${ICONS.more}</span></div></div>
    <iframe src="app.html"></iframe>
    <div class="home"></div>
  </div>`)

// ---------------------------------------------------------------- render

for (const [name, content] of [["shot-log", logScreen], ["shot-today", todayScreen], ["shot-charts", chartsScreen]] as const) {
  const file = join(PAGES, `${name}.html`)
  writeFileSync(file, content)
  const proc = Bun.spawnSync([
    CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
    "--force-device-scale-factor=2", "--window-size=390,845", "--virtual-time-budget=6000",
    `--screenshot=${join(OUT, `${name}.png`)}`, `file://${file}`,
  ], { stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`Chrome failed on ${name}: ${proc.stderr.toString()}`)
  console.log(`wrote scripts/screenshots/${name}.png`)
}

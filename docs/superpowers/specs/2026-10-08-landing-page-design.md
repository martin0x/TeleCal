# Landing Page and Access Requests — Design

**Date:** 2026-10-08
**Status:** Draft, awaiting owner review
**Visual reference:** [`assets/2026-10-08-landing-page-draft.html`](assets/2026-10-08-landing-page-draft.html) (approved draft v2; open it in a browser)

## Problem

TeleCal has no public face. The only way in is for the owner to learn someone's numeric
Telegram ID and run `/admin add`. A stranger who finds the bot gets
`⛔ Sorry, this bot is invite-only. Contact the admin to request access.`, with no way
to do so. The owner wants a page that showcases TeleCal now and can grow into selling it.

## Goals

1. A public landing page at the root of the existing web server that explains TeleCal
   and shows the real product (screenshots, not mockups).
2. One primary action, **Request access**, that ends with the owner able to approve a
   person in one tap, without ever handling a Telegram ID by hand.
3. The Mini App keeps working, including "View Charts" buttons already sent in chat
   history.

## Non-goals

- Payments, plans, accounts or a web login. Pricing shows a single free beta card.
- A custom domain, analytics, a privacy policy page, or translations.
- A framework, bundler or build step for the page.
- Any change to the `/log` flow or to what allowlisted users see.
- Removing emojis from bot messages. The no-emoji rule applies to the web page only.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Same Bun server, `/` = landing, `/app` = Mini App | One deploy, no new infra. |
| Access capture | Deep link into the bot (`t.me/<bot>?start=access`) | The allowlist is keyed by numeric ID, which a web form can't capture. The bot gets it for free. |
| Palette | "Berry": violet `#6D4AFF` on lavender-white `#F8F6FF`, ink `#1B1530` | Owner's pick. Telegram-adjacent without being Telegram blue. |
| Hero | Centered headline, phone rising from the bottom edge | Owner's pick. Best on mobile. |
| Product imagery | Real phone screenshots from a test account | Owner's call. Replaces the drawn chat. |
| Emojis | None on the page; inline SVG icons and an SVG logo mark | Owner: emoji-heavy pages read as sloppy. |
| Font | System stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`) | It's what Telegram uses. No webfont request. |
| Image format | JPEG, quality 85, resized with `sips` | No new dependency. `cwebp` isn't installed and WebP's savings are small at these sizes. |

## Landing page

### Files

| Path | What |
|---|---|
| `src/web/views/landing.html` (new) | The page. Inline CSS and JS, with `{{BOT_USERNAME}}` and `{{BASE_URL}}` placeholders. |
| `src/web/public/` (new) | Static assets served at `/assets/*`. |
| `src/web/public/favicon.svg` | The logo mark. |
| `src/web/public/og.png` | 1200×630 link-preview image. |
| `src/web/public/shot-log.jpg`, `shot-today.jpg`, `shot-charts.jpg` | The three screenshots, 720 px wide. |
| `scripts/og.html` + `scripts/build-landing-assets.sh` (new) | Renders `og.png` with headless Chrome and resizes screenshots with `sips`. Run by hand when assets change; outputs are committed. |

### Sections, in order

Copy and layout follow the draft. Summary:

1. **Nav** (sticky, blurred): logo + "TeleCal"; links How it works, Progress, Features,
   Pricing, FAQ (hidden under 780 px); "Request access" pill.
2. **Hero**: eyebrow "Free during beta · Invite-only"; H1 "Track calories by just
   texting."; lede; "Request access" plus a ghost "See how it works"; device frame holding
   `shot-log.jpg`, cropped by the frame's bottom edge.
3. **How it works** (`#how`): three step cards (say what you ate, it asks if it matters,
   tap to log), each with a small chat-bubble chip.
4. **Your progress** (`#progress`): copy on the left, two device frames on the right
   (`shot-today.jpg`, and `shot-charts.jpg` offset down). It stacks on mobile.
5. **Features** (`#features`): 6 cards with SVG icons: calories and protein, asks when
   unsure, daily goals, charts in Telegram, reminders, never loses an entry.
6. **Pricing** (`#pricing`): one card: Beta, $0 while invite-only, three checks,
   "Request access", footnote that paid plans may come later.
7. **FAQ** (`#faq`): `<details>` accordions: accuracy, local dishes, data, why Telegram,
   fixing mistakes / past dates, how to get access.
8. **Final band**: "Your next meal is a text away." + "Request access".
9. **Footer**: logo, "Made in Manila", "Open in Telegram", © 2026 TeleCal.

Every "Request access" link goes to `https://t.me/{{BOT_USERNAME}}?start=access`. "Open
in Telegram" goes to `https://t.me/{{BOT_USERNAME}}`.

### Visual system

- Colors are tokens on `:root`. Dark mode redefines them under
  `@media (prefers-color-scheme: dark)`: page `#0F0C1A`, surface `#17132A`, ink
  `#EEEAFB`, muted `#A39DBD`, line `#2A2444`, accent `#8B6DFF`. The screenshots stay as
  shot, inside the dark device frame.
- Device frame: `#1B1530` bezel, 44 px radius, soft violet-tinted shadow. Screenshots
  sit inside at 34 px radius with `object-fit: cover; object-position: top`.
- Images have explicit `width`/`height` to avoid layout shift. Everything below the hero
  uses `loading="lazy"`.
- At phone width there is no horizontal scroll and the side gutter is 16 px.
- `<head>` has a title, a meta description, Open Graph and Twitter card tags, `theme-color`
  and the SVG favicon. `og:image` and `og:url` must be absolute, so they use
  `{{BASE_URL}}/assets/og.png` (`BASE_URL` = `APP_URL` without a trailing slash).

### Mini App redirect

The first element in `<head>` is an inline script:

```js
if (location.hash.includes("tgWebAppData")) location.replace("/app" + location.hash)
```

Telegram opens a Web App with `#tgWebAppData=…` appended. Old "View Charts" buttons and
a BotFather menu button that point at the root URL therefore land in the Mini App with
their auth data intact. A normal visitor never has that hash.

## Web server — `src/web/server.ts`

- Split the `fetch` function out as `createFetchHandler(deps)` so tests can call it
  without binding a port. `startWebServer` wraps it in `Bun.serve`.
- `WebServerDeps` gains `botUsername: string`.
- Routes:

| Path | Response |
|---|---|
| `/`, `/index.html` | `landing.html` with both placeholders replaced. Read and rendered once at startup. |
| `/app`, `/app/` | `app.html`, unchanged. |
| `/assets/<name>` | A file from `src/web/public/`. `<name>` must match `^[a-z0-9-]+\.(svg\|png\|jpg)$`, which rules out traversal. Content type comes from the extension, with `Cache-Control: public, max-age=86400`. Anything else is 404. |
| `/api/*` | Unchanged. |

- `src/index.ts`: `await bot.init()` before `startWebServer`, then pass
  `bot.botInfo.username`. `bot.start()` later reuses the fetched info.

### Mini App URL

Add `config.web.miniAppUrl = APP_URL with any trailing slash removed + "/app"`. The four
`web_app: { url: config.web.appUrl }` sites in `today.ts` and `stats.ts` switch to it.
`APP_URL` on Railway stays as it is.

## Access requests

### Data — `src/db/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS access_requests (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined
  requested_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER
);
```

This is a new table, so `IF NOT EXISTS` is enough and no migration is needed.

### Repository — `src/db/repositories/access-requests.ts` (new)

- `find(id)`
- `request(id, username, firstName)` returns `"created" | "already_pending" | "declined"`.
  - No row: insert pending.
  - Row approved (the user was later removed): reset to pending and return `"created"`.
  - Pending: `"already_pending"`. Declined: `"declined"`.
- `decide(id, status, adminId)` returns the updated row, or `null` if it wasn't pending.
- `listPending(limit)`

### Gate — `src/bot/middleware/allowlist.ts`

`createAllowlistMiddleware(allowedUsersRepo, accessRequestsRepo, notifyAdmins)` keeps
its position at the top of the chain. Admins and allowlisted users pass through as
today. Everyone else is handled here, and `next()` is never called:

| Update from a non-allowlisted user | Response |
|---|---|
| Callback `access:req` | `request(...)`. `"created"`: answer the query, edit the message to "Request sent. You'll get a message here once you're approved.", and call `notifyAdmins`. `"already_pending"`: answer "Already requested. Hang tight." `"declined"`: answer "Your request wasn't approved." |
| Any other callback | Answer the query with "TeleCal is invite-only." (Today these are never answered, so the button spins.) |
| Anything else (`/start`, `/start access`, text, other commands) | "TeleCal is invite-only while in beta. Want in?" plus an inline **Request access** button (`access:req`). If their request is pending, say so instead and leave out the button. |

### Admin side

- **`notifyAdmins(request)`** sends each `ADMIN_USERS` account
  "Access request: First Name (@username), id 123" with **Approve** (`access:ok:<id>`)
  and **Decline** (`access:no:<id>`). A failed send (the admin never started the bot) is
  logged and skipped.
- **Callback router** (`src/bot/index.ts`): add an `access:` branch. If the presser isn't
  in `ADMIN_USERS`, answer "Admins only." Otherwise call `decide`:
  - Approve: `allowedUsersRepo.add(id, adminId)`, edit the admin message to
    "Approved by @admin", and send the user "You're in." followed by the `/start` help
    text.
  - Decline: edit the admin message to "Declined by @admin" and send the user "Thanks for
    your interest. TeleCal can't take you on right now."
  - Already decided: answer "Already approved/declined."
- **`/admin requests`** sends the oldest 10 pending requests, one message each, with the
  same buttons. With none it replies "No pending requests."
- **`/admin add <id>`** also marks a pending request for that ID approved, so the two
  paths can't disagree.
- The `/start` help text moves into an exported `HELP_TEXT` constant, shared by `/start`
  and the approval message.

## Screenshots — owner's shot list

Take these on a phone, from a **test Telegram account** (no real name, photo or history
visible). Use the light theme and a plain light chat wallpaper, ideally a soft lavender
close to `#ECE8FB`. Clear the status bar (full battery, no notifications) and send the
originals uncropped.

1. **`shot-log`**: `/log`, then "chicken adobo with rice". Answer the clarifying question
   with "1 cup rice, 2 pieces". Screenshot once the breakdown and the Log / Change /
   Cancel buttons show. If the bot doesn't ask a question, use any meal where it does.
2. **`shot-today`**: after logging 3–4 meals on a day with calorie and protein goals set,
   `/today`, showing items, totals, progress and the View Charts button.
3. **`shot-charts`**: tap View Charts and screenshot the week tab with a few days of data.
   Calories view.

Until the real shots arrive, local builds use the striped placeholder frames from the
draft. Don't push to `main` until the real shots are committed.

## Error handling

- `landing.html` missing at startup: log it and serve a plain 503 at `/`. `/app` and the
  API are unaffected.
- `bot.init()` failing (bad token, network): the process exits as it does today when
  `bot.start()` fails.
- Admin notification fails for every admin: log it. The request row still exists, and
  `/admin requests` surfaces it.
- Racing approve and decline taps: `decide` only acts on pending rows, so the second tap
  gets "Already …".

## Testing

Bun tests with in-memory SQLite, co-located:

- `src/web/server.test.ts` (new), via `createFetchHandler`:
  - `/` contains the injected username and base URL, and no `{{` left over.
  - `/app` returns the Mini App.
  - `/assets/favicon.svg` has the right content type.
  - `/assets/../config.ts`, `/assets/x.html` and an unknown asset return 404.
  - `/api/today` without auth returns 401.
- `src/db/repositories/access-requests.test.ts` (new): every `request` and `decide`
  transition in the tables above.
- `src/bot/middleware/allowlist.test.ts` (new) with a fake context:
  - An admin or allowlisted user calls `next`.
  - A stranger's `/start` gets the prompt with the button.
  - `access:req` creates a request and notifies once; a second tap doesn't notify again.
  - A declined user tapping doesn't notify.
- Admin callback tests:
  - A non-admin is refused.
  - Approve adds to the allowlist and messages the user.
  - A double decide answers "Already …".
- `config.web.miniAppUrl` with and without a trailing slash.

Manually, on a separate test bot token (pushing to `main` deploys to production):

- The page at 375 px and 1280 px, in light and dark mode.
- Opening `/#tgWebAppData=x` redirects to `/app`.
- The full loop: stranger `/start` → Request → admin Approve → stranger can `/log`.
- An old View Charts button still opens the Mini App.

## Open items for the owner

- **Copy to confirm:** the FAQ data answer ("Nothing else about you is shared") is a
  promise; "Made in Manila"; the Jollibee example in the FAQ.
- **Screenshots:** the three shots above.
- **Logo:** the SVG mark (a chat bubble with a dot) is a placeholder until there's a real
  one.

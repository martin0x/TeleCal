# 2. A Claude connector over MCP

Date: 2026-10-22
Status: Accepted

## Context

Users want to ask Claude on the web (claude.ai) about their own log: trends, averages, which days go over a goal. The only reader outside Telegram is the Mini App JSON API (`src/web/api.ts`), which authenticates with Telegram `initData`. Claude can't produce `initData`, and Claude on the web can't attach auth headers to arbitrary REST calls. Claude reads outside data through custom connectors, and a custom connector is a remote MCP server. Discussed in #23.

## Decision

Serve a stateless MCP server (Streamable HTTP, JSON responses, POST only) from the existing Bun web server at `/mcp/<token>`, built with `@modelcontextprotocol/sdk`.

- **Tools are read-only**: `get_profile`, `get_daily_totals`, `get_day` and `get_summary`. Ranges default to the last 30 days and are capped at 366 days per call. Days with nothing logged are marked `logged: false` instead of reading as zero-calorie days.
- **Auth is a per-user secret URL.** `/claude` in a private chat issues a random 32-byte token and replies with the connector URL. Sending `/claude` again replaces the token, and `/claude revoke` deletes it. Only the token's SHA-256 is stored, in `api_tokens`. A token works only while its user is allowlisted or an admin, the same gate as the bot. An unknown token, a revoked one and a user without access all get the same 404.
- **The path is never logged**, because the token in it is the credential.
- **Analytics** gets `claude_connector_created`, `claude_connector_revoked` and `claude_tool_called` (tool name only, never arguments or results).

### Privacy line

Connecting is an explicit opt-in by each user. Once connected, whatever Claude reads goes to Anthropic, meal descriptions included: `get_day` and `get_summary` return item descriptions, while `get_profile` and `get_daily_totals` return numbers only. The `/claude` reply, the README and the landing page FAQ say so.

## Consequences

- Anthropic becomes a processor of a user's whole history, not just the meal being estimated, but only for users who connect.
- The connector URL is a bearer credential stored by claude.ai. Anyone holding it can read that user's log until it is replaced or revoked.
- `@modelcontextprotocol/sdk` and `zod` become dependencies.

## Alternatives considered

- **OAuth 2.1 with dynamic client registration**, with sign-in through the Telegram Login Widget. This is the standard flow and avoids a secret in the URL, but it costs several times the code (metadata endpoints, client registration, auth codes with PKCE, refresh). It's worth revisiting if the connector is widely used.
- **A `/export` CSV for the user to upload.** No endpoint or auth, but manual every time.
- **A plain REST endpoint.** Claude on the web can't call one that needs auth.

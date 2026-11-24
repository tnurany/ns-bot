# NS Bot

Read-only NetSuite assistant. Claude answers questions by querying NetSuite
through Oracle's NetSuite AI Connector Service (MCP).

Stages 1/2 (connection, chat loop) are done. Stage 3 is the Teams bot, running
locally against Azure Bot Service. Hosting and per-user OAuth come later.

## Stack

Node 22.12+ (`.nvmrc` pins 24), ESM (`"type": "module"`), `@anthropic-ai/sdk`,
`@microsoft/teams.apps`, `dotenv`, `jsonc-parser`. No build step, no TypeScript, no test
framework yet. Run things with `npm run <script>`.

## Layout

```
prompts/*.md    System prompt, split by concern, concatenated in filename order
src/config.js   Env loading and validation
src/prompt.js   Concatenates prompts/*.md
appPackage/     Teams app manifest and icons
src/claude.js   The API call and output formatting
src/core.js     Conversation history, result expiry, turn limit (chat + Teams)
src/ask.js      One question
src/chat.js     Conversation loop
src/teams.js    Teams bot
src/log.js      Question log (logs/*.jsonl) and the "wrong" flag
src/directory.js  Department and email lookup through Microsoft Graph, for the log
src/cost.js     Dollar cost from token usage (list prices)
src/limits.js   Spend limits per person: limits.jsonc, ledger, admin commands
src/departments.js  Entra departments with headcounts (npm run departments)
limits.jsonc    Company, department and per-person limits, with comments
src/review.js   Digest + CSV from the log (npm run review)
src/check.js    Preflight diagnostics
src/pkce.js     OAuth sign-in for the shared login
src/token.js    OAuth flow pieces, token requests, shared login refresh
src/signin.js   Personal NetSuite sign-in from Teams: link, card, callback route
src/user-tokens.js  Each person's NetSuite tokens, encrypted (AES-256-GCM), refreshed per person
src/refresh-token.js  Token refresh
```

## NetSuite constraints (learned the hard way, do not rediscover)

- **Refresh tokens last 168 hours. Hard ceiling, cannot be raised.** For a
  confidential client (ours: client secret, Basic auth) a refresh returns a
  new access token only, no new refresh token, so the clock is NOT reset:
  re-authorization is due 7 days after sign-in no matter how often you
  refresh. Oracle's Step Two docs show no refresh_token in the refresh
  response, and the sandbox confirmed it (2026-09-29). Still save a
  refresh_token if one ever comes back. Public clients do rotate, but rotation
  is capped (integration record "Maximum Time For Token Rotation", default
  168h).
- **PKCE is required for the `mcp` scope** even for confidential clients
  (S256 only), and token requests must authenticate with an HTTP Basic header.
  Azure Bot Service's built-in OAuth connections document neither (no PKCE
  fields, client credentials only in the body), so they don't fit NetSuite
  without workarounds.
- **Access tokens last about 1 hour.**
- **NetSuite rejects `http://` redirect URIs entirely.** Must be https, even
  for localhost. `https://localhost/callback` works; the page fails to load and
  you read the code out of the address bar.
- **The `mcp` scope cannot be combined with other scopes.** It goes alone. On
  the integration record the checkbox is named "NetSuite AI Connector Service".
- **Oracle's docs disagree on the token endpoint host.** Both
  `<account>.suitetalk.api.netsuite.com` and `<account>.app.netsuite.com` appear
  in official docs. Keep this switchable via env var, do not hardcode.
- **Account ID formatting:** `1234567_SB1` becomes `1234567-sb1` in hostnames.
  Underscore to hyphen, lowercased.
- **Administrator role is blocked from MCP** by Oracle. Authorization must use
  a custom role with MCP Server Connection and Log in using OAuth 2.0 Access
  Tokens. Note "Log in using Access Tokens" is a different permission and does
  not work.
- **`ns_prompt_library_app`, `ns_report_filters_app` and `ns_selector_app`
  must never be called.** They render interactive HTML the Messages API cannot
  display, and their descriptions instruct the model to wait for a user
  response that never arrives, which stalls the turn.
- **The tool list grows with the MCP role's permissions.** Record permissions
  add `ns_createRecord` and `ns_updateRecord` (write) plus `ns_getRecord` and
  `ns_getRecordTypeMetadata`. Write tools are in `BLOCKED_TOOLS` as a backstop;
  `npm run check` warns when they are exposed.
- **`ns_listSavedSearches` without `query` returns every saved search** (about
  2,700, ~82K tokens). Saved search IDs are script IDs (`customsearch9695`),
  not the number in the URL.
- **`ns_runCustomSuiteQL` truncates silently at 5000 rows.** Pagination is
  mandatory for customer, item, transaction, salesorder, journalentry,
  employee, contact, vendor. This is the most likely source of a wrong number.
- **SuiteQL is SQL-92 plus Oracle functions.** `ROWNUM` not `LIMIT`, `NVL` not
  `ISNULL`, `SUBSTR` not `SUBSTRING`, `||` not `CONCAT`, `TO_DATE()` for date
  literals. No CTEs, no `OFFSET/FETCH`, no mixing ANSI and comma joins.

## Anthropic API notes

- The MCP connector is server-side: Anthropic's API is the MCP client. We pass
  `mcp_servers` with an `authorization_token`. We do not write an MCP client.
- **The connector beta has changed shape across revisions.** Since
  `mcp-client-2025-11-20`, tool blocking is an `mcp_toolset` entry in `tools`
  with `configs: {name: {enabled: false}}`; the 2025-04-04
  `tool_configuration` is rejected. The old code retried without the filter
  and silently exposed the write tools on every request. Never add a fallback that
  drops `configs`. On a 400, read the error and check the docs.
- The connector supports tool calls only, not MCP resources or prompts.
- **Thinking tokens count against `max_tokens`.** Thinking is on by default on
  current models. A 4,000 cap was used up by thinking plus pagination before
  any answer text. 16,000 is the ceiling for non-streaming requests; going
  higher means streaming.
- **The connector's server-side tool loop pauses after 10 iterations**
  (`stop_reason: "pause_turn"`). `askClaude` resumes by resending the turn so
  far as the assistant message, with no new user message.
- **Thinking blocks are not stored in history.** They are bound to the exact
  prior history, and result expiry rewrites it; replaying them after the
  rewrite is a 400 on accounts created on or after 2026-08-31.

## Teams notes

- **Teams times out a request after about 15 seconds and retries.** Answers
  take 30-60s, so `teams.js` must not await the answer inside the handler.
  It starts the work, returns, and sends the reply later.
- **Teams SDK DevTools (`@microsoft/teams.dev`) is deprecated** and stuck at
  2.0.12. Local testing uses Agents Playground (`npm run playground`).
- **Teams credentials are `TEAMS_*` in `.env`, passed to `App` explicitly.**
  The SDK's default env names (`CLIENT_ID`, `CLIENT_SECRET`) are too easily
  confused with `NS_CLIENT_ID`/`NS_CLIENT_SECRET`.
- **`--local` disables request authentication**, so it binds to 127.0.0.1
  only. Never deploy with it.
- **Expired-result notes must say they were added after the fact.** A bare
  "expired" stub before an old answer makes the model tell the user its
  earlier answer had no data behind it.
- **`logs/` holds NetSuite data and user identities.** Tool results are
  stored as a 500-char preview plus row count, never the full rows. Logging
  is wrapped so a write failure can never break an answer. Only the Teams
  bot logs; `chat` is the developer tool and stays out of the data.
- **Department and email in the log come from Microsoft Graph**, through the SDK's
  `app.graph` (app-only token from the `TEAMS_*` credentials, no extra
  package). Needs the Graph application permission `User.Read.All` with
  admin consent. `User.ReadBasic.All` returns department blank, and only a
  Global Administrator can consent Graph application permissions. Lookups
  are cached a day per person; a 403 turns them off for the run with one
  message that says how to fix it.
- **Personal NetSuite sign-in is our own OAuth flow** (`signin.js`), not
  Azure's OAuth connections (no PKCE, no Basic header). The callback is
  `NS_SIGNIN_REDIRECT_URI`, which must be on the integration record. Links
  go out in 1:1 chats only (in a group anyone could attach their login to
  someone else's Teams account); state is single use, 10 minutes.
- **A NetSuite access token is a JWT whose `sub` is `<role id>;<entity id>`.**
  `tokenClaims()` reads it for the log and the confirmation message. SuiteQL
  has no role table, so the role name waits for `ns_getSessionInfo`.
- **NetSuite issues a token for any role, including ones MCP refuses**
  (Administrator, no MCP Server Connection). The callback makes one
  `tools/list` call before saving, so the person hears it then, not on their
  first question.
- **Someone whose sign-in ran out never falls back to the shared login.** The
  record stays (marked dead) so they get the sign-in card instead. History
  is keyed by conversation and person, and reset on sign-in and sign-out, so
  no answer mixes rows pulled under two logins.
- **NetSuite result shapes differ by tool.** Saved searches return a bare
  JSON array; SuiteQL returns `{resultCount, totalResults, data}`;
  metadata returns `{success, metadata}`. `rowCount` in log.js handles all
  three.

## Spend limits

- Per person: rolling 4 hours, calendar week (Monday), calendar month, in
  local time (`TZ`). Three tiers in `limits.jsonc`: `company`, `departments`
  (an entry covers its key or the Entra spellings in its `match` list),
  `people` keyed by email or Entra object ID. Reread on change.
- Spend is `cost` on each log entry (list price from `src/cost.js`), so the
  ledger is rebuilt from `logs/` at startup. The check runs before the
  Claude call; a person can overrun by one question. `charge()` runs after
  the answer and appends a note when usage crosses 75/90/95/100 percent.
  Users see percentages only; dollars are for admins (`limit <email>`).
- **`limits.jsonc` is JSON with comments** (jsonc-parser, trailing commas
  allowed), so non-developers can uncomment a department. `limit set/clear`
  in Teams must edit it through jsonc-parser's `modify`, never
  `JSON.stringify`, or every comment is lost. Admins are `LIMIT_ADMINS`.
  When hosted, `LIMITS_FILE` must point outside the deployed folder or a
  deploy overwrites Teams edits.
- **The Entra department field is messy**: about 30% of people have none,
  and teams appear under several spellings ("IT" and "Information
  Technology"). `company` is the real control; add a department entry only
  when it should differ, with every spelling in its `match` list.
- A missing or broken `limits.jsonc` at startup is fatal on purpose. A
  broken edit while running keeps the last good version.

## Conventions

- Prompt files reload on every run, including every turn of `chat`. Never cache
  them.
- The access token must be read live from `process.env` at call time, never
  frozen at import, so a mid-run refresh takes effect.
- Errors should explain the likely cause and the fix, not just rethrow. This is
  a learning project and the error messages are documentation.
- Comments explain why, not what. Prefer a comment about a NetSuite quirk over
  restating the code.
- No emojis in output. ANSI colors are fine.
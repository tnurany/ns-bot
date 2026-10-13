# NS Bot

Read-only NetSuite assistant. Claude answers questions by querying NetSuite
through Oracle's NetSuite AI Connector Service (MCP).

Currently at Stage 1/2 of a staged build: prove the connection, then a chat
loop. Teams bot and per-user OAuth come later.

## Stack

Node 20+, ESM (`"type": "module"`), `@anthropic-ai/sdk`, `dotenv`. No build
step, no TypeScript, no test framework yet. Run things with `npm run <script>`.

## Layout

```
prompts/*.md    System prompt, split by concern, concatenated in filename order
src/config.js   Env loading and validation
src/prompt.js   Concatenates prompts/*.md
src/claude.js   The API call and output formatting
src/ask.js      One question
src/chat.js     Conversation loop
src/check.js    Preflight diagnostics
src/pkce.js     Full OAuth authorization flow
src/refresh-token.js  Token refresh
```

## NetSuite constraints (learned the hard way, do not rediscover)

- **Refresh tokens last 168 hours. Hard ceiling, cannot be raised.** Each
  refresh issues a new refresh token and resets the clock. The old one dies
  immediately, so saving the new one is mandatory.
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
- **The beta header value and `tool_configuration` shape have changed across
  revisions.** Keep both configurable from `.env`. On a 400 mentioning either,
  read the error and check the docs rather than guessing.
- The connector supports tool calls only, not MCP resources or prompts.

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
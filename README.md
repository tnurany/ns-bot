# NS Bot

A read-only NetSuite assistant. Claude answers questions by querying NetSuite
through Oracle's NetSuite AI Connector Service (MCP).

Stages 1 and 2 (prove the connection, then talk to it) are done. Stage 3, the
Teams bot, runs locally and through Azure Bot Service. No per-user OAuth and
no hosting yet.

## Setup

Needs Node 22.12 or later (the Teams SDK requires it). `.nvmrc` pins 24:

```bash
cd ns-bot
nvm use
npm install
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where it comes from |
| --- | --- |
| `ANTHROPIC_API_KEY` | platform.claude.com > API keys |
| `NS_ACCOUNT` | Setup > Company > Company Information > ACCOUNT ID, with `_` turned into `-` and lowercased |
| `NS_MCP_URL` | Same account ID substituted into the template |
| `NS_CLIENT_ID` / `NS_CLIENT_SECRET` | Your NetSuite integration record, shown once at save |
| `NS_ACCESS_TOKEN` / `NS_REFRESH_TOKEN` | Run `npm run pkce` |

Then:

```bash
npm run check
```

That verifies your environment, the Anthropic key, and the NetSuite MCP
endpoint, and lists which tools your role exposes. Fix anything it flags
before moving on.

## Daily use

```bash
npm run ask -- "How many subsidiaries do we have?"
npm run chat
```

`chat` accepts: `exit`, `reset`, `cost`, `verbose`.

NetSuite results stay in a conversation's history for `RESULT_TTL_MINUTES`
(default 60). After that they are swapped for an "expired" note and a
follow-up runs the query again. Same behavior in `chat` and Teams.

Each answer ends with when its data was pulled and until when follow-ups
reuse it. The code adds that line, not Claude, so it costs no tokens. Saying
`refresh` (or "pull that again") makes Claude rerun the query early.

## Teams

Test locally first. No Azure needed:

```bash
npm run teams:local      # terminal 1: the bot, on localhost only
npm run playground       # terminal 2: a Teams-like chat in the browser
```

For real Teams, add `TEAMS_CLIENT_ID`, `TEAMS_TENANT_ID` and
`TEAMS_CLIENT_SECRET` from the Azure Bot registration to `.env`, then:

1. `npm run teams` (listens on port 3978)
2. Expose it over HTTPS with a dev tunnel. One-time setup:
   `brew install --cask devtunnel`, `devtunnel user login`, then create a
   persistent tunnel so the URL stays the same between runs:
   `devtunnel create ns-bot --allow-anonymous` and
   `devtunnel port create ns-bot -p 3978`. Each session: `devtunnel host ns-bot`.
   Anonymous is fine: the bot rejects any request not signed by Bot Service.
3. In the Azure portal, set the bot's **Messaging endpoint** to
   `https://<tunnel-host>/api/messages`.
4. `npm run teams:package`, then in Teams: Apps > Manage your apps > Upload an
   app > upload `ns-bot-teams.zip`. Needs custom app upload permission.

In Teams, `help` and `reset` are commands. The console prints who asked what
and the tool trace for every question.

`appPackage/` holds the manifest and placeholder icons. Bump `version` in
`manifest.json` whenever you re-upload a changed package.

## Token refresh is automatic

- **Access token: about 1 hour.** `src/token.js` refreshes it before any
  request that would land within 2 minutes of expiry, and again if NetSuite
  rejects it anyway. The new access token, new refresh token and
  `NS_TOKEN_EXPIRES_AT` are written to both `process.env` and `.env`, so a
  long `chat` session survives across the hour. `npm run refresh` still works
  if you want to force one.
- **Refresh token: 168 hours (7 days), hard ceiling.** Each refresh issues a
  new one and resets the clock, and the old one dies immediately. Any use of
  `ask`, `chat` or `check` that triggers a refresh keeps you signed in. Go 7
  days with no refresh and you get `invalid_grant`; redo `npm run pkce`.

Auto-refresh needs `NS_CLIENT_ID`, `NS_CLIENT_SECRET` and `NS_REFRESH_TOKEN`.
`npm run check` warns if any are missing and shows minutes left on the token.

The 7-day limit is a NetSuite constraint, not something the code can work
around. It becomes a significant user experience problem at Stage 4 when real
users are involved.

## Layout

```
prompts/       The system prompt, split by concern, concatenated in filename order
  00-core.md     Role, scope, how to answer, pagination rules
  10-schema.md   Custom field glossary. Fill in reactively.
  20-vocabulary.md  Business terms, subsidiaries, fiscal calendar
  30-patterns.md    SuiteQL dialect notes and validated queries
  40-safety.md      What never to return

appPackage/      Teams app manifest and icons

src/
  config.js        Env loading and validation
  prompt.js        Concatenates prompts/*.md
  claude.js        The API call and output formatting
  core.js          Conversation history, result expiry, turn limit
  ask.js           One question (Stage 1)
  chat.js          Conversation loop (Stage 2)
  teams.js         Teams bot (Stage 3)
  check.js         Preflight diagnostics
  pkce.js          Full OAuth authorization
  token.js         Token lifecycle: refresh, persist, expiry
  refresh-token.js Force a refresh (CLI wrapper over token.js)
```

## Working on the prompts

Prompt files reload on every run, including every turn inside `chat`. Edit a
file in one window and the next question uses it. No restart.

**Write them reactively.** When the bot gets something wrong, read the tool
trace to see what it actually did, then add that specific correction to the
right file. Do not write a schema primer up front. A guessed-at glossary
documents what you assume it misunderstands, which is rarely what it actually
misunderstands.

**Keep them tight.** Every token in `prompts/` is sent on every request. At one
user that is irrelevant. At 200 users asking 10 questions a day, an extra 1,000
tokens is 2 million extra input tokens per day. Before going past a handful of
people, wire up prompt caching.

## Reading the output

```
[TOOL]    what Claude called and with what arguments
[RESULT]  what NetSuite returned
[usage]   tokens in and out
```

The tool trace is the point. The answer text alone will not tell you whether
it queried NetSuite, invented a field name, or answered from nothing.

When an answer looks wrong, check the trace first, then NetSuite's own log at
Setup > Integration > Manage Integrations > your record > AI Connector Service
(MCP) execution log.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` on the MCP server | Refreshed automatically. If it persists after refresh, check the MCP role permissions or `npm run pkce` |
| `400` mentioning beta header | Revision mismatch. Try a different `MCP_BETA_HEADER`, check the Anthropic MCP connector docs |
| `400` mentioning `mcp_toolset` or `configs` | Connector shape changed. Check the Anthropic MCP connector docs; never drop `configs`, it keeps the write tools blocked |
| `MCP_BETA_HEADER=mcp-client-2025-04-04 is the old...` | Set `MCP_BETA_HEADER=mcp-client-2025-11-20` in `.env` |
| `invalid_grant` on refresh | Refresh token older than 7 days. `npm run pkce` |
| `404` on token endpoint | Set `NS_TOKEN_HOST=<account>.app.netsuite.com` in `.env`. Oracle's docs disagree with each other |
| Tools list is empty | MCP role permissions, or the SuiteApp is not installed in this account |
| Bot stalls with no answer | It called an interactive app tool. Check `BLOCKED_TOOLS` in `src/config.js` |
| Teams shows typing, then nothing | Check the bot console. If the answer was printed, the reply could not be delivered: check the messaging endpoint and `TEAMS_*` values |
| `401` in the bot console on every Teams message | Wrong `TEAMS_CLIENT_ID` or `TEAMS_TENANT_ID`, or the request did not come from Bot Service |
| Answer is confidently wrong | Read the trace. Usually pagination or a guessed field name. Add the correction to `prompts/` |

## Do not commit .env

It holds a live Anthropic key and live NetSuite credentials. `.gitignore`
covers it. Check before your first commit.

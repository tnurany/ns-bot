# NS Bot

A read-only NetSuite assistant. Claude answers questions by querying NetSuite
through Oracle's NetSuite AI Connector Service (MCP).

This covers Stages 1 and 2 of the build: prove the connection works, then talk
to it. No Teams, no per-user OAuth, no hosting yet.

## Setup

```bash
cd ns-bot
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

src/
  config.js        Env loading and validation
  prompt.js        Concatenates prompts/*.md
  claude.js        The API call and output formatting
  ask.js           One question (Stage 1)
  chat.js          Conversation loop (Stage 2)
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
| `400` mentioning `tool_configuration` | Shape changed. The code retries without it automatically |
| `invalid_grant` on refresh | Refresh token older than 7 days. `npm run pkce` |
| `404` on token endpoint | Set `NS_TOKEN_HOST=<account>.app.netsuite.com` in `.env`. Oracle's docs disagree with each other |
| Tools list is empty | MCP role permissions, or the SuiteApp is not installed in this account |
| Bot stalls with no answer | It called an interactive app tool. Check `BLOCKED_TOOLS` in `src/config.js` |
| Answer is confidently wrong | Read the trace. Usually pagination or a guessed field name. Add the correction to `prompts/` |

## Do not commit .env

It holds a live Anthropic key and live NetSuite credentials. `.gitignore`
covers it. Check before your first commit.

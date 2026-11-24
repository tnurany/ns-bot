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
   `curl -sL https://aka.ms/DevTunnelCliInstall | bash` (or
   `brew install --cask devtunnel`), `devtunnel user login`, then create a
   persistent tunnel so the URL stays the same between runs:
   `devtunnel create ns-bot --allow-anonymous` and
   `devtunnel port create ns-bot -p 3978`. Each session: `devtunnel host ns-bot`.
   Anonymous is fine: the bot rejects any request not signed by Bot Service.
3. In the Azure portal, set the bot's **Messaging endpoint** to
   `https://<tunnel-host>/api/messages`.
4. `npm run teams:package`, then in Teams: Apps > Manage your apps > Upload an
   app > upload `ns-bot-teams.zip`. Needs custom app upload permission.

In Teams, `help`, `reset`, `refresh`, `wrong`, `budget`, `sign in` and
`sign out` are commands. The console prints who asked what and the tool trace
for every question.

### Personal NetSuite sign-in

Each person can sign in to NetSuite from Teams, and the bot then answers with
their own role: they see exactly what that role can see. Anyone who has not
signed in is answered with the shared login from `npm run pkce`, unless
`NS_SIGNIN_REQUIRED=true`.

Azure Bot Service's built-in sign-in can't be used: NetSuite requires PKCE and
an HTTP Basic header at the token endpoint, and Azure's OAuth connections
support neither. `src/signin.js` runs the same flow as `npm run pkce`, with a
callback route on the bot instead of a pasted URL.

Setup, once:

1. In NetSuite, add the callback to the integration record's redirect URIs,
   next to `https://localhost/callback`:
   `https://<tunnel-host>/auth/netsuite/callback`
2. In `.env`, set `NS_SIGNIN_REDIRECT_URI` to exactly that URL, and
   `NS_USER_TOKENS_KEY` to 32 random bytes in base64 (command in
   `.env.example`).
3. Each person's NetSuite role needs **MCP Server Connection** and **Log in
   using OAuth 2.0 Access Tokens**, plus whatever record permissions they
   should have. Administrator does not work: Oracle blocks it.

How it works for a person:

- `sign in` (1:1 chat only, so nobody else can click their link) sends a card
  with a NetSuite link. It works once and expires in 10 minutes.
- They sign in, pick their role and click Allow. The tab says "Signed in", and
  the bot confirms in Teams with the role ID.
- The bot refreshes their access token every hour. **After 7 days they must
  sign in again**: NetSuite does not extend the refresh token. The bot warns a
  day ahead, and when it runs out it sends the card and answers the question
  once they are back.
- Someone whose sign-in ran out never falls back to the shared login, which
  might see more than their role.
- `sign out` deletes their tokens.

Tokens are stored encrypted in `data/user-tokens.enc` (or
`NS_USER_TOKENS_FILE`). Losing or changing the key signs everyone out. Each
log entry records which login answered (`login`: `"shared"` or the role and
entity IDs).

History is kept per person, even in a group chat, so a follow-up never reuses
rows pulled under someone else's role.

`appPackage/` holds the manifest and placeholder icons. Bump `version` in
`manifest.json` whenever you re-upload a changed package.

## Logs and review

The Teams bot writes every question, answer and command to `logs/`, one
JSON line per turn, one file per day (`LOG_DIR` in `.env` moves it). Each
question entry keeps who asked, their email and department, the exact NetSuite calls (tool, full input
such as the SuiteQL, row count, 500-character result preview), whether data
was pulled fresh, tokens, seconds, any error, and whether the reply reached
Teams. Users reply `wrong` (optionally `wrong, that's last year's total`) to
flag the last answer.

```bash
npm run review          # last 7 days
npm run review -- 30    # last 30 days
```

Prints totals, usage by person, flagged answers, errors, the slowest
questions and every question with a one-line answer, and writes
`logs/review-<date>.csv` for Excel.

The logs contain NetSuite data. Treat them like NetSuite exports: `logs/` is
gitignored, and the folder lives wherever the bot runs. The terminal `chat`
does not log, so developer testing stays out of the data.

### Department and email lookup

Department and email come from Entra ID, where Teams reads them for the
profile card. The bot looks them up through Microsoft Graph as its own app, once a day
per person, and `review` groups questions by it. That takes one permission
on the bot's app registration, granted once:

1. entra.microsoft.com > App registrations > All applications > the bot's
   app (the `TEAMS_CLIENT_ID`) > API permissions > Add a permission.
2. Microsoft Graph > Application permissions > `User.Read.All` > Add.
3. Grant admin consent for the tenant. Only a Global Administrator can click
   this for Graph application permissions; Application Administrator cannot.

`User.ReadBasic.All` looks like the smaller grant but returns department
blank. Until consent is granted the bot says so at startup and logs
questions with no department or email. Playground sessions carry no Entra ID and are
never looked up.

## Spend limits

Each person has a dollar budget per rolling 4 hours, per calendar week
(Monday to Sunday) and per calendar month, in the server's local time.
`limits.jsonc` has three tiers. It is JSON with `//` comments, so the file
explains itself and lists every Entra department commented out; delete the
`//` in front of one to give it its own numbers:

```jsonc
{
  "company": { "4h": 2, "week": 10, "month": 30 },
  "departments": {
    "IT_default": { "match": ["IT", "Information Technology"], "4h": 2, "week": 10, "month": 30 },
    "Purchasing": { "4h": 2, "week": 10, "month": 30 }
  },
  "people": {
    "someone@tommycarwash.com": { "week": 25 }
  }
}
```

- `company`: everyone not covered below, including people with no
  department in Entra and departments with no entry.
- `departments`: an entry matches its own name, or every Entra spelling
  listed under `match`, since one team is often spelled several ways
  (case does not matter). `npm run departments` lists every department in
  Entra ID with its headcount and which entry covers it, in the file's own
  syntax for pasting; uncomment only the ones that should differ from
  `company`.
- `people`: any window for one person, keyed by email or Entra object ID.

A window left out means no limit; `0` blocks. The file is reread
when it changes, so edits need no restart; a typo keeps the last good
version and prints the error.

Spend is the list-price cost of each answered question (`src/cost.js`),
rebuilt from the log at startup, so a restart keeps everyone's totals. The
check runs before a question goes to Claude: over any limit, the bot says
which one and when it resets, and logs the refusal.

People never see dollar amounts. `budget` shows their usage as a percentage
of each limit, and an answer that carries any window past 75, 90, 95 or
100 percent ends with a one-line note saying so (and, at 100, when they can
ask again). Admins see the dollar figures in `limit <email>`.

Admins listed in `LIMIT_ADMINS` (emails, or Entra object IDs until the
Graph permission is granted) can edit a person's limits from Teams:

```
limit someone@tommycarwash.com              their usage and limits
limit set someone@tommycarwash.com week 25  one window; "default" removes it
limit clear someone@tommycarwash.com        all custom limits off
```

These edit `limits.jsonc` in place, comments included, and every command
is in the log. Company-wide and department limits are edited in the file.
When hosted, set `LIMITS_FILE` to a path outside the deployed folder
(`/home/limits.jsonc` on App Service) so a deploy does not overwrite
limits set from Teams.

## Token refresh is automatic

- **Access token: about 1 hour.** `src/token.js` refreshes it before any
  request that would land within 2 minutes of expiry, and again if NetSuite
  rejects it anyway. The new access token and `NS_TOKEN_EXPIRES_AT` are
  written to both `process.env` and `.env`, so a
  long `chat` session survives across the hour. `npm run refresh` still works
  if you want to force one.
- **Refresh token: 168 hours (7 days), hard ceiling.** For our confidential
  client a refresh returns no new refresh token, so the clock is not reset:
  7 days after `npm run pkce` you get `invalid_grant` however often the bot
  was used. Redo `npm run pkce` weekly.

Auto-refresh needs `NS_CLIENT_ID`, `NS_CLIENT_SECRET` and `NS_REFRESH_TOKEN`.
`npm run check` warns if any are missing and shows minutes left on the token.

The 7-day limit is a NetSuite constraint, not something the code can work
around. People who sign in from Teams hit it too: see Personal NetSuite
sign-in above.

## Layout

```
prompts/       The system prompt, split by concern, concatenated in filename order
  00-core.md     Role, scope, how to answer, pagination rules
  10-schema.md   Custom field glossary. Fill in reactively.
  20-vocabulary.md  Business terms, subsidiaries, fiscal calendar
  30-patterns.md    SuiteQL dialect notes and validated queries
  40-safety.md      What never to return

appPackage/      Teams app manifest and icons
limits.jsonc     Spend limits by department and person, with comments

src/
  config.js        Env loading and validation
  prompt.js        Concatenates prompts/*.md
  claude.js        The API call and output formatting
  core.js          Conversation history, result expiry, turn limit
  ask.js           One question (Stage 1)
  chat.js          Conversation loop (Stage 2)
  teams.js         Teams bot (Stage 3)
  log.js           Question log: JSONL per day, flagging
  directory.js     Department and email lookup through Microsoft Graph
  cost.js          Dollar cost of a request from its token usage
  limits.js        Spend limits: limits.jsonc, the ledger, the admin commands
  departments.js   Lists Entra departments with headcounts (npm run departments)
  review.js        Digest and CSV from the log
  check.js         Preflight diagnostics
  pkce.js          OAuth sign-in for the shared login
  token.js         OAuth flow pieces, token requests, shared login refresh
  signin.js        Personal NetSuite sign-in from Teams: link, card, callback
  user-tokens.js   Each person's NetSuite tokens, encrypted, refreshed per person
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
| `No spend limits file at ...` at startup | `limits.jsonc` is missing where `LIMITS_FILE` points. Copy it from the repo |
| `[limits] ... has a syntax error` | A hand edit broke the file, usually a missing comma or quote; the line number is in the message. The bot keeps the last good version until it is fixed |
| "Only NS Bot admins can view or change spend limits" | Add your email (or Entra object ID while Graph is off) to `LIMIT_ADMINS` in `.env` and restart |
| `[directory] Department lookup is off` at startup | The Graph permission `User.Read.All` is missing or not consented on the bot's app registration. See "Department and email lookup" |
| Answer is confidently wrong | Read the trace. Usually pagination or a guessed field name. Add the correction to `prompts/` |

## Do not commit .env

It holds a live Anthropic key and live NetSuite credentials. `.gitignore`
covers it. Check before your first commit.

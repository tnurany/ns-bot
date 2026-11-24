/**
 * Stage 3: NS Bot in Microsoft Teams.
 *
 *   npm run teams:local    no Azure, for Agents Playground (npm run playground)
 *   npm run teams          real Teams through Azure Bot Service
 *
 * Teams gives a bot about 15 seconds to answer each HTTP request and retries
 * when it does not. A NetSuite question with several tool calls takes 30-60
 * seconds. So the handler starts the work, returns at once, and posts the
 * answer when it is ready. Awaiting the answer inside the handler holds the
 * request open past the timeout, and the retry asks the question twice.
 */
import http from "node:http";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { ask, reset, freshnessNote, TTL_MINUTES } from "./core.js";
import { answerText, printResponse, explainError } from "./claude.js";
import { costOf } from "./cost.js";
import { logQuestion, logCommand, logBlocked, flagLast, whoFrom, LOG_DIR } from "./log.js";
import * as limits from "./limits.js";
import { createDirectory } from "./directory.js";
import * as signin from "./signin.js";
import * as userTokens from "./user-tokens.js";

const local = process.argv.includes("--local");
const port = Number(process.env.PORT) || 3978;

const TEAMS_VARS = ["TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET", "TEAMS_TENANT_ID"];
if (!local) {
  const missing = TEAMS_VARS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `Missing ${missing.join(", ")} in .env.\n` +
        "These come from the Azure Bot registration (App ID, client secret, tenant ID).\n" +
        "To test without Azure, run: npm run teams:local"
    );
    process.exit(1);
  }
}

// Per-person NetSuite sign-in. Off unless NS_SIGNIN_REDIRECT_URI is set; a
// half-finished setup stops the bot here rather than quietly answering
// everyone with the shared login.
let SIGNIN = false;
try {
  SIGNIN = signin.configure();
  if (SIGNIN) userTokens.load();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const HELP =
  "Ask me a question about NetSuite data, for example: " +
  '"How many open sales orders do we have?"\n\n' +
  "I only read data; I can't change anything in NetSuite.\n\n" +
  `Data I pull is reused for follow-up questions for ${TTL_MINUTES} minutes, then pulled ` +
  "again. Each answer says when its data was pulled.\n\n" +
  "- **refresh**: pull fresh data for the last answer now\n" +
  "- **budget**: how much of your usage limits you have used\n" +
  "- **wrong**: flag the last answer for review, e.g. `wrong, that's last year's total`\n" +
  "- **reset**: clear your history in this chat and start over" +
  (SIGNIN
    ? "\n- **sign in**: use your own NetSuite access, so answers show what your NetSuite role can see\n" +
      "- **sign out**: stop using your NetSuite sign-in"
    : "");

const server = http.createServer();
const adapter = new ExpressAdapter(server);
adapter.get("/", (_req, res) => res.send("NS Bot is running."));

// NetSuite sends the browser here after a person signs in. Public on
// purpose: the single-use state in the URL is what ties it to a Teams user.
if (SIGNIN) {
  adapter.get(signin.callbackPath(), async (req, res) => {
    const out = await signin.callback(req.query);
    // The URL carries the authorization code: never cache it or pass it on.
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.status(out.status).type("html").send(out.html);
  });
}

const app = new App({
  httpServerAdapter: adapter,
  // Passed explicitly because the SDK otherwise reads CLIENT_ID and
  // CLIENT_SECRET from the environment, names too easily confused with the
  // NetSuite NS_CLIENT_ID and NS_CLIENT_SECRET.
  ...(local
    ? { dangerouslyAllowUnauthenticatedRequests: true }
    : {
        clientId: process.env.TEAMS_CLIENT_ID,
        clientSecret: process.env.TEAMS_CLIENT_SECRET,
        tenantId: process.env.TEAMS_TENANT_ID,
      }),
  // In a channel the message arrives as "<at>NS Bot</at> question".
  activity: { mentions: { stripText: true } },
});

// Department and email for the log come from Entra ID through Graph, as the app.
// Local mode has no app credentials, and the Playground sends no object ID.
const directory = createDirectory(local ? null : app.graph);

app.on("message", async ({ activity, send }) => {
  const text = (activity.text || "").trim();
  if (!text) return;
  const conversation = activity.conversation.id;
  // Cached per person, so this waits on Graph about once a day per user.
  const who = await directory.enrich(whoFrom(activity));
  // The Playground sends no Entra object ID; its Teams ID is stable enough there.
  const userKey = who.id || who.teamsId;
  // History is per person even in a group chat. With personal sign-in two
  // people can have different NetSuite roles, and a follow-up must not
  // reuse rows that someone else's role pulled.
  const ctx = { conversation, who, userKey, history: `${conversation}|${userKey}`, send };

  const command = text.toLowerCase();
  if (command === "reset") {
    reset(ctx.history);
    logCommand({ conversation, who, command });
    await send("History cleared. Ask a new question.");
    return;
  }
  if (command === "help") {
    logCommand({ conversation, who, command });
    await send(HELP);
    return;
  }
  if (command === "budget") {
    logCommand({ conversation, who, command });
    await send(limits.report(who));
    return;
  }
  if (/^(sign|log) ?in$/.test(command)) {
    logCommand({ conversation, who, command });
    await offerSignIn(ctx, signInIntro(userKey));
    return;
  }
  if (/^(sign|log) ?out$/.test(command)) {
    logCommand({ conversation, who, command });
    await send(signOut(ctx));
    return;
  }
  // Admins: "limit", "limit set <email> week 25", "limit clear <email>",
  // "limit <email>". The shapes are specific so a NetSuite question that
  // happens to start with "limit" still gets answered.
  const admin = /^limits?(?:\s+(?:set|clear)\s.*|\s+\S+@\S+|\s+[0-9a-f-]{36}|)$/is.exec(text);
  if (admin) {
    logCommand({ conversation, who, command: text }); // the audit trail for limit changes
    await send(limits.adminCommand(who, text.replace(/^limits?\s*/i, "")));
    return;
  }
  // "wrong", "wrong: the total is off", "Wrong - that's last year"
  const flag = /^wrong\b[\s,:;.-]*(.*)$/is.exec(text);
  if (flag) {
    const flagged = flagLast({ conversation, who, note: flag[1].trim() });
    await send(
      flagged
        ? "Flagged for review. Thanks, that helps improve the answers."
        : "Nothing to flag yet in this chat. Ask a question first, then reply **wrong** if the answer is off."
    );
    return;
  }

  // Who asked what, with the tool trace printed after it: the audit trail.
  console.log(`\n\x1b[1m[${new Date().toLocaleString()}] ${who.name || who.id}:\x1b[0m ${text}`);

  const over = limits.check(who);
  if (over) {
    console.log(`\x1b[33m  blocked: ${over.window} spend $${over.spent.toFixed(2)} of $${over.limit.toFixed(2)}\x1b[0m`);
    logBlocked({ conversation, who, question: text, window: over.window, limit: over.limit, spent: over.spent });
    await send(limits.blockedMessage(over));
    return;
  }

  const login = await chooseLogin(ctx, text);
  if (login === null) return; // a sign-in card went out instead

  // Deliberately not awaited. See the header comment.
  answer(ctx, text, login);
});

/**
 * Whose NetSuite access answers this person: their own login, undefined for
 * the bot's shared one, or null when they must sign in first (the card has
 * been sent, and the question is answered once they finish).
 */
async function chooseLogin(ctx, question) {
  if (!SIGNIN) return undefined;
  const { state } = userTokens.status(ctx.userKey);
  if (state === "ok") return userTokens.loginFor(ctx.userKey);
  if (state === "expired") {
    // Never the shared login for someone who signed in: it may see more
    // than their own role does.
    await offerSignIn(ctx, EXPIRED_INTRO, question);
    return null;
  }
  if (signin.REQUIRED) {
    await offerSignIn(ctx, "Sign in to NetSuite first, so I answer with your own access. I'll answer your question once you're signed in.", question);
    return null;
  }
  return undefined;
}

const EXPIRED_INTRO =
  "Your NetSuite sign-in has run out (each one lasts 7 days). Sign in again and I'll answer your question.";

function signInIntro(userKey) {
  const s = SIGNIN && userTokens.status(userKey);
  if (s?.state === "ok") {
    return (
      `You're signed in to NetSuite with role ID ${s.record.role} until ${when(s.until)}. ` +
      "Signing in again starts a new 7 days, and lets you pick a different role."
    );
  }
  return "Sign in to NetSuite so I answer with your own access: you see exactly what your NetSuite role can see.";
}

/** Sends the sign-in card, if this chat may have one. */
async function offerSignIn(ctx, intro, question = null) {
  if (!SIGNIN) {
    await ctx.send("Personal NetSuite sign-in isn't turned on for this bot. I answer with the bot's shared NetSuite login.");
    return;
  }
  // In a group chat anyone could click the link and attach their own
  // NetSuite login to this person's Teams account.
  if (ctx.who.chat !== "personal") {
    await ctx.send(
      "Sign-in links only go out in a 1:1 chat with me, so nobody else can use yours. Message me directly and say **sign in**."
    );
    return;
  }
  const url = signin.link(ctx.userKey, (result) => finishSignIn(ctx, result, question));
  await ctx.send(signin.card(url, intro));
}

/** Runs when the browser comes back from NetSuite, minutes after the card went out. */
async function finishSignIn(ctx, result, question) {
  try {
    if (!result.ok) {
      await ctx.send(result.message);
      return;
    }
    const { role, entity } = result.record;
    // Rows pulled under the shared login may show more than this person's
    // role allows. None of them may feed an answer from now on.
    reset(ctx.history);
    logCommand({ conversation: ctx.conversation, who: ctx.who, command: "signed in", login: { role, entity } });
    console.log(`\x1b[1m[${new Date().toLocaleString()}] ${ctx.who.name || ctx.userKey} signed in to NetSuite, role ${role}\x1b[0m`);
    const { until } = userTokens.status(ctx.userKey);
    await ctx.send(
      `Signed in to NetSuite with role ID ${role}. I now answer with your own NetSuite access, so you see ` +
        `what that role can see. This sign-in lasts until ${when(until)}; say **sign out** to stop using it.`
    );
    if (question) answer(ctx, question, userTokens.loginFor(ctx.userKey));
  } catch (err) {
    console.error("\x1b[31m[sign-in] could not finish in Teams:\x1b[0m", err.message);
  }
}

function signOut(ctx) {
  if (!SIGNIN || !userTokens.forget(ctx.userKey)) return "You weren't signed in to NetSuite, so nothing changed.";
  // So no answer mixes data pulled under two different logins.
  reset(ctx.history);
  return signin.REQUIRED
    ? "Signed out of NetSuite. Say **sign in** when you want to ask something again."
    : "Signed out of NetSuite. I'll answer with the bot's shared login until you sign in again.";
}

// Server-local time, like the freshness notes. Set TZ when hosted.
const when = (ms) =>
  new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Long enough that someone who uses the bot once a day sees it in time.
const RENEW_WARNING_MS = 24 * 60 * 60 * 1000;

async function answer(ctx, text, login) {
  const { conversation, who, send } = ctx;
  const typing = () => send({ type: "typing" }).catch(() => {});
  typing();
  // Teams drops the typing indicator after a few seconds, so keep it alive
  // for as long as NetSuite takes.
  const timer = setInterval(typing, 3000);
  const started = Date.now();

  let reply;
  let result;
  let error;
  let signInAgain = false;
  try {
    result = await ask(ctx.history, text, { login });
    printResponse(result.response);
    reply = answerText(result.response);
    const note = freshnessNote(result);
    if (note) reply += `\n\n_${note}_`;
    // Charged before the reply goes out: the tokens are spent either way.
    // The note is the person's only warning before a limit blocks them.
    const budget = limits.charge(who, costOf(result.response.usage));
    if (budget) reply += `\n\n_${budget}_`;
    const signedIn = login && userTokens.status(ctx.userKey);
    if (signedIn?.state === "ok" && signedIn.until - Date.now() < RENEW_WARNING_MS) {
      reply += `\n\n_Your NetSuite sign-in runs out ${when(signedIn.until)}. Say **sign in** to renew it for another 7 days._`;
    }
  } catch (err) {
    error = err;
    if (err instanceof userTokens.SignInRequired) {
      signInAgain = true; // a sign-in card goes out instead of an error
    } else {
      explainError(err);
      reply = userFacingError(err, login);
    }
  } finally {
    // Before the reply, or a late typing event lands after the answer.
    clearInterval(timer);
  }

  let delivered = false;
  try {
    if (signInAgain) {
      console.log(`\x1b[33m  ${who.name || ctx.userKey}: NetSuite sign-in ran out, sent a sign-in card\x1b[0m`);
      await offerSignIn(ctx, EXPIRED_INTRO, text);
    } else {
      for (const part of splitForTeams(reply)) {
        await send({ type: "message", text: part, textFormat: "markdown" });
      }
    }
    delivered = true;
  } catch (err) {
    console.error("\x1b[31mCould not deliver the answer to Teams:\x1b[0m", err.message);
  }

  const record = login && userTokens.status(ctx.userKey).record;

  logQuestion({
    conversation,
    who,
    question: text,
    response: result?.response,
    pulledAt: result?.pulledAt,
    fresh: result?.fresh,
    seconds: (Date.now() - started) / 1000,
    error,
    delivered,
    login: record ? { role: record.role, entity: record.entity } : undefined,
  });
}

// Teams rejects a message over about 28 KB, markup included. Rare, but a
// month-by-month table over several years gets there. Long answers are split
// at line breaks, well under the limit.
const TEAMS_MAX_CHARS = 20000;

function splitForTeams(text) {
  if (text.length <= TEAMS_MAX_CHARS) return [text];
  const lines = text.split("\n");
  const parts = [];
  let part = [];
  let size = 0;
  let header = null; // header row + separator of the table being written

  lines.forEach((line, i) => {
    const isRow = line.trimStart().startsWith("|");
    if (!isRow) header = null;
    else if (!header && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      header = [line, lines[i + 1]];
    }

    if (part.length && size + line.length + 1 > TEAMS_MAX_CHARS) {
      parts.push(part.join("\n"));
      // A table cut in two would arrive headerless in the second message.
      part = header && isRow && !header.includes(line) ? [...header] : [];
      size = part.join("\n").length;
    }
    part.push(line);
    size += line.length + 1;
  });

  if (part.length) parts.push(part.join("\n"));
  return parts;
}

// The person in Teams cannot fix a token or a key, so tell them what
// happened and who can. The full explanation goes to the console.
function userFacingError(err, login) {
  const msg = String(err?.message || "");
  if (err?.status === 429) {
    return "NS Bot is getting too many requests right now. Try again in a minute.";
  }
  // The SDK already retried twice. A network blip on the host or a short
  // outage at Anthropic looks the same from here, and both pass.
  if (err?.name === "APIConnectionError" || /connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return "NS Bot couldn't reach its AI service just now. This usually passes within a minute; please try again.";
  }
  // A person's own token rejected even after a refresh: most likely their
  // role lost access to the connector, which is theirs to sort out.
  if (login && err?.status === 401 && !/x-api-key/i.test(msg)) {
    return (
      "NetSuite turned down your sign-in. Say **sign in** to sign in again. If that doesn't help, " +
      "your role may have lost access to the NetSuite AI connector; check with your NetSuite admin."
    );
  }
  // 401 can be the NetSuite token or the Anthropic key; either way it is
  // the owner's to fix, so the message does not guess which.
  if (msg.includes("invalid_grant") || msg.includes("Cannot refresh") || err?.status === 401) {
    return "NS Bot can't sign in to its services right now. Let the bot's owner know.";
  }
  return "Something went wrong answering that. Try again, or rephrase the question.";
}

await app.initialize();

// Fails loudly when limits.json is missing or broken: better than a bot
// with no spend limits. The ledger comes from the log, so a restart keeps
// everyone's running totals.
console.log(limits.describe());
console.log(`Spend ledger: ${limits.loadLedger()} answers from the log`);
console.log(
  SIGNIN
    ? `Personal NetSuite sign-in: on, callback ${signin.REDIRECT_URI}` +
        (signin.REQUIRED ? " (required)" : " (others use the shared login)")
    : "Personal NetSuite sign-in: off, everyone uses the shared login"
);

if (local) {
  // Local mode skips the check that a request really came from Teams, so it
  // listens on this machine only. Anything on the network could otherwise
  // query NetSuite through it.
  server.listen(port, "127.0.0.1", () => {
    console.log(`NS Bot (local, no Teams auth) on http://localhost:${port}/api/messages`);
    console.log("In another terminal: npm run playground");
  });
} else {
  server.listen(port, async () => {
    console.log(`NS Bot on port ${port}, messaging endpoint path /api/messages`);
    console.log(`Logging questions and answers to ${LOG_DIR} (npm run review)`);
    await directory.probe();
  });
}

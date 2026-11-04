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
import { logQuestion, logCommand, flagLast, whoFrom, LOG_DIR } from "./log.js";

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

const HELP =
  "Ask me a question about NetSuite data, for example: " +
  '"How many open sales orders do we have?"\n\n' +
  "I only read data; I can't change anything in NetSuite.\n\n" +
  `Data I pull is reused for follow-up questions for ${TTL_MINUTES} minutes, then pulled ` +
  "again. Each answer says when its data was pulled.\n\n" +
  "- **refresh**: pull fresh data for the last answer now\n" +
  "- **wrong**: flag the last answer for review, e.g. `wrong, that's last year's total`\n" +
  "- **reset**: clear this chat's history and start over";

const server = http.createServer();
const adapter = new ExpressAdapter(server);
adapter.get("/", (_req, res) => res.send("NS Bot is running."));

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

app.on("message", async ({ activity, send }) => {
  const text = (activity.text || "").trim();
  if (!text) return;
  const conversation = activity.conversation.id;
  const who = whoFrom(activity);

  const command = text.toLowerCase();
  if (command === "reset") {
    reset(conversation);
    logCommand({ conversation, who, command });
    await send("History cleared. Ask a new question.");
    return;
  }
  if (command === "help") {
    logCommand({ conversation, who, command });
    await send(HELP);
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

  // Deliberately not awaited. See the header comment.
  answer(conversation, who, text, send);
});

async function answer(conversation, who, text, send) {
  const typing = () => send({ type: "typing" }).catch(() => {});
  typing();
  // Teams drops the typing indicator after a few seconds, so keep it alive
  // for as long as NetSuite takes.
  const timer = setInterval(typing, 3000);
  const started = Date.now();

  let reply;
  let result;
  let error;
  try {
    result = await ask(conversation, text);
    printResponse(result.response);
    reply = answerText(result.response);
    const note = freshnessNote(result);
    if (note) reply += `\n\n_${note}_`;
  } catch (err) {
    error = err;
    explainError(err);
    reply = userFacingError(err);
  } finally {
    // Before the reply, or a late typing event lands after the answer.
    clearInterval(timer);
  }

  let delivered = false;
  try {
    for (const part of splitForTeams(reply)) {
      await send({ type: "message", text: part, textFormat: "markdown" });
    }
    delivered = true;
  } catch (err) {
    console.error("\x1b[31mCould not deliver the answer to Teams:\x1b[0m", err.message);
  }

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
function userFacingError(err) {
  const msg = String(err?.message || "");
  if (err?.status === 429) {
    return "NS Bot is getting too many requests right now. Try again in a minute.";
  }
  // The SDK already retried twice. A network blip on the host or a short
  // outage at Anthropic looks the same from here, and both pass.
  if (err?.name === "APIConnectionError" || /connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return "NS Bot couldn't reach its AI service just now. This usually passes within a minute; please try again.";
  }
  // 401 can be the NetSuite token or the Anthropic key; either way it is
  // the owner's to fix, so the message does not guess which.
  if (msg.includes("invalid_grant") || msg.includes("Cannot refresh") || err?.status === 401) {
    return "NS Bot can't sign in to its services right now. Let the bot's owner know.";
  }
  return "Something went wrong answering that. Try again, or rephrase the question.";
}

await app.initialize();

if (local) {
  // Local mode skips the check that a request really came from Teams, so it
  // listens on this machine only. Anything on the network could otherwise
  // query NetSuite through it.
  server.listen(port, "127.0.0.1", () => {
    console.log(`NS Bot (local, no Teams auth) on http://localhost:${port}/api/messages`);
    console.log("In another terminal: npm run playground");
  });
} else {
  server.listen(port, () => {
    console.log(`NS Bot on port ${port}, messaging endpoint path /api/messages`);
    console.log(`Logging questions and answers to ${LOG_DIR} (npm run review)`);
  });
}

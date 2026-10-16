/**
 * Conversation state, shared by the terminal chat and the Teams bot.
 *
 * The API is stateless: every request carries the whole conversation,
 * INCLUDING the mcp_tool_use and mcp_tool_result blocks. Strip those and the
 * model forgets what it looked up, then re-queries or contradicts itself.
 * Keep them forever and it answers follow-ups from numbers that went stale
 * hours ago. So results are kept, but once they pass RESULT_TTL_MINUTES their
 * content is swapped for an "expired" note, and the system prompt tells the
 * model to run the query again.
 */
import { loadSystemPrompt } from "./prompt.js";
import { askClaude } from "./claude.js";

export const TTL_MINUTES = Number(process.env.RESULT_TTL_MINUTES) || 60;
const TTL_MS = TTL_MINUTES * 60 * 1000;

// A Teams chat never ends on its own. Without a cap, every turn resends the
// whole history and the cost of a question keeps climbing.
const MAX_TURNS = 20;

// Conversations idle this long are forgotten, so memory does not grow with
// every chat the bot has ever seen.
const IDLE_MS = 12 * 60 * 60 * 1000;

const conversations = new Map();

function conversation(id) {
  let c = conversations.get(id);
  if (!c) {
    c = { turns: [], queue: Promise.resolve() };
    conversations.set(id, c);
  }
  c.lastUsed = Date.now();
  return c;
}

function forgetIdle() {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, c] of conversations) if (c.lastUsed < cutoff) conversations.delete(id);
}

/**
 * Asks a question in a conversation. Resolves to { response, pulledAt, fresh }:
 * the raw API response, when the NetSuite data behind the answer was pulled
 * (null if none was involved), and whether this turn pulled it.
 *
 * Turns in one conversation run one at a time. Two messages sent in quick
 * succession would otherwise both read the history before either answer is
 * saved, and "and last year?" would arrive without the question it follows.
 */
export function ask(conversationId, question) {
  forgetIdle();
  const c = conversation(conversationId);
  const run = c.queue.then(() => turn(c, question));
  c.queue = run.catch(() => {}); // a failed turn must not block the next one
  return run;
}

export function reset(conversationId) {
  conversations.delete(conversationId);
}

async function turn(c, question) {
  const now = Date.now();
  const messages = [];
  for (const t of c.turns) {
    messages.push({ role: "user", content: t.question });
    messages.push({
      role: "assistant",
      content: now - t.at > TTL_MS ? expire(t.content, t.at) : t.content,
    });
  }
  messages.push({ role: "user", content: question });

  // Prompt files are reloaded every turn, so an edit applies to the next
  // question without a restart.
  const res = await askClaude({ system: loadSystemPrompt(), messages });

  // Which data the model actually leaned on is not knowable, so this is the
  // conservative reading: if it queried NetSuite this turn, the data is new;
  // otherwise it could only have reused an unexpired earlier result, and the
  // oldest one is reported.
  const fresh = hasData(res.content);
  const reusable = c.turns.filter((t) => now - t.at <= TTL_MS && hasData(t.content));
  const pulledAt = fresh ? now : reusable.length ? Math.min(...reusable.map((t) => t.at)) : null;

  // Thinking blocks are not kept. On current models each one is bound to the
  // exact history it was produced with, and expire() rewrites that history;
  // replaying a block after the rewrite is a 400 on Anthropic accounts created
  // on or after 2026-08-31. Follow-ups do not need the old reasoning, only
  // the questions, tool calls, results and answers.
  const content = res.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");

  // Saved only on success, so a failed turn leaves the history valid.
  // Timestamped at the start of the turn: the results are at least this old.
  if (content.length) c.turns.push({ question, content, at: now });
  if (c.turns.length > MAX_TURNS) c.turns.splice(0, c.turns.length - MAX_TURNS);
  return { response: res, pulledAt, fresh };
}

/**
 * One line telling the user how old the data is and when it will be pulled
 * again. Added by the caller after the answer, never sent to the model, so
 * it costs no tokens. Null when the answer involved no NetSuite data.
 */
export function freshnessNote({ pulledAt, fresh }) {
  if (!pulledAt) return null;
  const until = clock(pulledAt + TTL_MS);
  return fresh
    ? `Pulled from NetSuite at ${clock(pulledAt)}. Follow-ups reuse this data until ${until}; say "refresh" to pull it again.`
    : `Answered from NetSuite data pulled at ${clock(pulledAt)}, reused until ${until}. Say "refresh" to pull it again.`;
}

const hasData = (content) => content.some((b) => b.type === "mcp_tool_result");

// Server-local time. A hosted server runs in UTC, so set TZ in its
// environment or these times will be off by hours.
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// The mcp_tool_use block stays, so the model can see exactly which query or
// saved search to run again. Only the returned data is dropped.
//
// The note must say it was written after the turn ended. The model reads the
// transcript literally: an "expired" result sitting right before its old
// answer reads as "I answered with no data", and it then tells the user its
// previous answer was unfounded.
function expire(content, at) {
  const fetched = clock(at);
  const note =
    `Expired: [Edited by NS Bot after this turn ended.] NetSuite returned rows here ` +
    `at ${fetched}, and the answer that follows was correctly based on them. The ` +
    `rows were removed later because they are now more than ${TTL_MINUTES} minutes ` +
    "old. Run this again if a new question depends on them.";
  return content.map((b) =>
    b.type === "mcp_tool_result" ? { ...b, content: [{ type: "text", text: note }] } : b
  );
}

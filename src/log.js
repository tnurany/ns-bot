/**
 * Question-and-answer log for the Teams bot.
 *
 * One JSON object per line, one file per local day, in logs/ (or LOG_DIR).
 * The point is to learn what people ask and what they get back, so each
 * question entry keeps the exact NetSuite calls the model made. Tool results
 * are kept as a short preview plus a row count: the full rows are NetSuite
 * data by the hundred and belong in NetSuite, not in a log file.
 *
 * Logging must never break an answer. Every write is wrapped, and a failure
 * goes to the console only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const LOG_DIR =
  process.env.LOG_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "logs");

const PREVIEW_CHARS = 500;

// The last question entry per conversation, so a "wrong" can point at it.
// In memory only: after a restart a flag carries no id and review.js falls
// back to the previous question in the same conversation.
const lastQuestion = new Map();

function write(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${localDate(entry.at)}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("\x1b[31m[log] could not write entry:\x1b[0m", err.message);
  }
}

// File names follow the server's local date, like the times in the answers.
function localDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Teams identity fields worth keeping, from an inbound activity. */
export function whoFrom(activity) {
  return {
    name: activity.from?.name || null,
    id: activity.from?.aadObjectId || null, // Entra object ID, stable across devices
    teamsId: activity.from?.id || null,
    chat: activity.conversation?.conversationType || null, // personal, groupChat, channel
  };
}

/**
 * A question and what came of it. `response` is the raw API response (may be
 * absent when the request failed), `error` the thrown error if any.
 */
export function logQuestion({ conversation, who, question, response, pulledAt, fresh, seconds, error, delivered }) {
  const entry = {
    id: randomBytes(4).toString("hex"),
    at: new Date().toISOString(),
    kind: "question",
    conversation,
    who,
    question,
    answer: null,
    calls: response ? extractCalls(response.content) : [],
    fresh: Boolean(fresh),
    pulledAt: pulledAt ? new Date(pulledAt).toISOString() : null,
    stop: response?.stop_reason || null,
    tokens: response ? { in: response.usage?.input_tokens || 0, out: response.usage?.output_tokens || 0 } : null,
    seconds: Math.round(seconds * 10) / 10,
    error: error ? String(error.message || error).slice(0, 500) : null,
    delivered: Boolean(delivered),
  };
  if (response) entry.answer = textOf(response.content);
  write(entry);
  lastQuestion.set(conversation, entry.id);
  return entry.id;
}

/** help, reset and the like: cheap to keep, and they show how people use the bot. */
export function logCommand({ conversation, who, command }) {
  write({ at: new Date().toISOString(), kind: "command", conversation, who, command });
}

/**
 * The user said the last answer was wrong. Returns false when this
 * conversation has no answer to flag since the bot started.
 */
export function flagLast({ conversation, who, note }) {
  const about = lastQuestion.get(conversation) || null;
  write({ at: new Date().toISOString(), kind: "flag", conversation, who, about, note: note || null });
  return Boolean(about);
}

// Everything the model said, including narration between tool calls. The
// answer the user saw is the tail of this; the log keeps the whole thing.
function textOf(content) {
  return (content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

// Pairs each mcp_tool_use with its mcp_tool_result by id.
function extractCalls(content) {
  const results = new Map();
  for (const b of content || []) {
    if (b.type === "mcp_tool_result") results.set(b.tool_use_id, b);
  }
  const calls = [];
  for (const b of content || []) {
    if (b.type !== "mcp_tool_use") continue;
    const r = results.get(b.id);
    const text = r ? (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("") : "";
    calls.push({
      tool: b.name,
      input: b.input,
      rows: rowCount(text),
      error: r?.is_error ? text.slice(0, PREVIEW_CHARS) : null,
      preview: r?.is_error ? null : text.slice(0, PREVIEW_CHARS),
    });
  }
  return calls;
}

// Saved searches return a bare JSON array of rows. SuiteQL returns
// {resultCount, totalResults, data: [...]}, where totalResults is the count
// across all pages and resultCount this page's. Metadata and other
// non-row results count as unknown.
export function rowCount(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v.length;
    if (!v || typeof v !== "object") return null;
    for (const k of ["totalResults", "resultCount"]) {
      if (Number.isFinite(Number(v[k])) && v[k] !== null && v[k] !== "") return Number(v[k]);
    }
    for (const k of ["data", "items", "results", "rows"]) {
      if (Array.isArray(v[k])) return v[k].length;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

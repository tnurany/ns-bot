/**
 * Reads the question log and prints a digest, plus a CSV for Excel.
 *
 *   npm run review           last 7 days
 *   npm run review -- 30     last 30 days
 *
 * The digest answers the questions you ask after a week of real use: who is
 * using it, what are they asking, what did they flag as wrong, what failed,
 * what was slow, and what is it costing.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import { LOG_DIR } from "./log.js";

const days = Number(process.argv[2]) || 7;

// Dollars per million tokens, Anthropic list prices. Update when the model
// or the price list changes; the figure is an estimate, not an invoice.
const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};
const model = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const price = PRICES[model] || PRICES["claude-sonnet-5-5"];

if (!existsSync(LOG_DIR)) {
  console.log(`No log directory at ${LOG_DIR} yet. It appears after the first Teams question.`);
  process.exit(0);
}

const since = new Date();
since.setDate(since.getDate() - days);
since.setHours(0, 0, 0, 0);

const entries = readdirSync(LOG_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && new Date(f.slice(0, 10)) >= since)
  .sort()
  .flatMap((f) => readFileSync(join(LOG_DIR, f), "utf8").split("\n").filter(Boolean))
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null; // a half-written line from a crash mid-append
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.at.localeCompare(b.at));

const questions = entries.filter((e) => e.kind === "question");
const flags = entries.filter((e) => e.kind === "flag");
const commands = entries.filter((e) => e.kind === "command");

// Attach flags to the answers they are about. A flag written after a bot
// restart has no id, so it goes to the previous question in that chat.
const byId = new Map(questions.map((q) => [q.id, q]));
for (const f of flags) {
  let q = f.about ? byId.get(f.about) : null;
  if (!q) q = [...questions].reverse().find((x) => x.conversation === f.conversation && x.at < f.at);
  if (q) (q.flags ??= []).push(f.note || "(no note)");
}

const B = "\x1b[1m", D = "\x1b[90m", R = "\x1b[31m", Y = "\x1b[33m", X = "\x1b[0m";
const when = (iso) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
const name = (e) => e.who?.name || e.who?.id || "unknown";
const oneLine = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
const callSummary = (q) =>
  (q.calls || []).map((c) => c.tool.replace(/^ns_/, "") + (c.rows != null ? `(${c.rows} rows)` : "")).join(", ");

console.log(`${B}NS Bot review: last ${days} days${X} ${D}(${LOG_DIR})${X}\n`);

if (!questions.length) {
  console.log("No questions in this period.");
  process.exit(0);
}

// Totals
const users = new Map();
for (const q of questions) users.set(name(q), (users.get(name(q)) || 0) + 1);
const tokIn = questions.reduce((s, q) => s + (q.tokens?.in || 0), 0);
const tokOut = questions.reduce((s, q) => s + (q.tokens?.out || 0), 0);
const cost = (tokIn * price.in + tokOut * price.out) / 1e6;
const errors = questions.filter((q) => q.error);
const flagged = questions.filter((q) => q.flags);
const undelivered = questions.filter((q) => !q.error && !q.delivered);
const avgSec = questions.reduce((s, q) => s + (q.seconds || 0), 0) / questions.length;
const fresh = questions.filter((q) => q.fresh).length;

console.log(
  `${questions.length} questions from ${users.size} people, ${commands.length} commands\n` +
    `${fresh} pulled fresh NetSuite data, ${questions.length - fresh} answered from recent data or no data\n` +
    `${flagged.length} flagged wrong, ${errors.length} errors, ${undelivered.length} not delivered to Teams\n` +
    `avg ${avgSec.toFixed(0)}s per answer, ${tokIn.toLocaleString()} tokens in / ${tokOut.toLocaleString()} out, ` +
    `about $${cost.toFixed(2)} (${model})\n`
);

console.log(`${B}By person${X}`);
for (const [n, c] of [...users].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${n}`);

if (flagged.length) {
  console.log(`\n${B}${Y}Flagged as wrong${X}`);
  for (const q of flagged) {
    console.log(`  ${D}${when(q.at)}${X} ${name(q)}: ${q.question}`);
    for (const n of q.flags) console.log(`    ${Y}flag:${X} ${n}`);
    console.log(`    ${D}calls:${X} ${callSummary(q) || "none"}`);
    console.log(`    ${D}answer:${X} ${oneLine(q.answer, 300)}`);
  }
}

if (errors.length) {
  console.log(`\n${B}${R}Errors${X}`);
  for (const q of errors) console.log(`  ${D}${when(q.at)}${X} ${name(q)}: ${q.question}\n    ${R}${oneLine(q.error, 200)}${X}`);
}

const slow = [...questions].filter((q) => !q.error).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log(`\n${B}Slowest${X}`);
for (const q of slow) console.log(`  ${String(q.seconds.toFixed(0)).padStart(4)}s  ${oneLine(q.question, 80)}  ${D}${callSummary(q)}${X}`);

console.log(`\n${B}All questions${X}`);
for (const q of questions) {
  const mark = q.flags ? `${Y}WRONG ${X}` : q.error ? `${R}ERROR ${X}` : "";
  console.log(`  ${D}${when(q.at)}${X} ${B}${name(q)}${X}: ${q.question}`);
  console.log(`    ${mark}${D}${oneLine(q.answer || q.error, 160)}${X}`);
}

// CSV, one row per question, for sorting and filtering in Excel. The BOM
// makes Excel read it as UTF-8 instead of guessing.
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const rows = [
  ["time", "person", "chat", "question", "answer", "netsuite_calls", "queries", "fresh_data", "seconds", "tokens_in", "tokens_out", "error", "flagged", "flag_notes"],
  ...questions.map((q) => [
    new Date(q.at).toLocaleString(),
    name(q),
    q.who?.chat,
    q.question,
    q.answer,
    callSummary(q),
    (q.calls || []).map((c) => JSON.stringify(c.input)).join(" | "),
    q.fresh ? "yes" : "no",
    q.seconds,
    q.tokens?.in,
    q.tokens?.out,
    q.error,
    q.flags ? "yes" : "",
    (q.flags || []).join(" | "),
  ]),
];
const csvPath = join(LOG_DIR, `review-${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(csvPath, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
console.log(`\nCSV for Excel: ${csvPath}`);

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
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import { LOG_DIR, readEntries } from "./log.js";
import { costOf, MODEL } from "./cost.js";

const days = Number(process.argv[2]) || 7;

if (!existsSync(LOG_DIR)) {
  console.log(`No log directory at ${LOG_DIR} yet. It appears after the first Teams question.`);
  process.exit(0);
}

const entries = readEntries(days);
const questions = entries.filter((e) => e.kind === "question");
const flags = entries.filter((e) => e.kind === "flag");
const commands = entries.filter((e) => e.kind === "command");
const blocked = entries.filter((e) => e.kind === "blocked");

// Entries from before costs were logged are priced at today's list price.
const costOfQ = (q) => q.cost ?? costOf(q.tokens);
const money = (n) => `$${n.toFixed(2)}`;

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
const users = new Map(); // name -> { count, cost, department }
for (const q of questions) {
  const u = users.get(name(q)) || { count: 0, cost: 0, department: null };
  u.count++;
  u.cost += costOfQ(q);
  u.department = q.who?.department || u.department;
  users.set(name(q), u);
}
const depts = new Map(); // department -> { count, cost }
for (const q of questions) {
  const d = depts.get(q.who?.department || "(unknown)") || { count: 0, cost: 0 };
  d.count++;
  d.cost += costOfQ(q);
  depts.set(q.who?.department || "(unknown)", d);
}
const tokIn = questions.reduce((s, q) => s + (q.tokens?.in || 0), 0);
const tokOut = questions.reduce((s, q) => s + (q.tokens?.out || 0), 0);
const cost = questions.reduce((s, q) => s + costOfQ(q), 0);
const errors = questions.filter((q) => q.error);
const flagged = questions.filter((q) => q.flags);
const undelivered = questions.filter((q) => !q.error && !q.delivered);
const avgSec = questions.reduce((s, q) => s + (q.seconds || 0), 0) / questions.length;
const fresh = questions.filter((q) => q.fresh).length;

console.log(
  `${questions.length} questions from ${users.size} people, ${commands.length} commands\n` +
    `${fresh} pulled fresh NetSuite data, ${questions.length - fresh} answered from recent data or no data\n` +
    `${flagged.length} flagged wrong, ${errors.length} errors, ${undelivered.length} not delivered to Teams, ` +
    `${blocked.length} blocked by spend limits\n` +
    `avg ${avgSec.toFixed(0)}s per answer, ${tokIn.toLocaleString()} tokens in / ${tokOut.toLocaleString()} out, ` +
    `about ${money(cost)} (${MODEL})\n`
);

console.log(`${B}By person${X}`);
for (const [n, u] of [...users].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(u.count).padStart(4)}  ${money(u.cost).padStart(7)}  ${n}${u.department ? `  ${D}${u.department}${X}` : ""}`);
}

// Departments come from Entra ID through Graph (src/directory.js). All
// unknown means the permission is not granted yet, so the section is skipped.
if ([...depts.keys()].some((d) => d !== "(unknown)")) {
  console.log(`\n${B}By department${X}`);
  for (const [d, c] of [...depts].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(c.count).padStart(4)}  ${money(c.cost).padStart(7)}  ${d}`);
  }
}

if (blocked.length) {
  console.log(`\n${B}${Y}Blocked by spend limits${X}`);
  for (const b of blocked) {
    console.log(`  ${D}${when(b.at)}${X} ${name(b)}: ${oneLine(b.question, 80)}  ${D}${b.window} ${money(b.spent)} of ${money(b.limit)}${X}`);
  }
}

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
  ["time", "person", "email", "department", "chat", "question", "answer", "netsuite_calls", "queries", "fresh_data", "seconds", "tokens_in", "tokens_out", "cost", "error", "flagged", "flag_notes"],
  ...questions.map((q) => [
    new Date(q.at).toLocaleString(),
    name(q),
    q.who?.email,
    q.who?.department,
    q.who?.chat,
    q.question,
    q.answer,
    callSummary(q),
    (q.calls || []).map((c) => JSON.stringify(c.input)).join(" | "),
    q.fresh ? "yes" : "no",
    q.seconds,
    q.tokens?.in,
    q.tokens?.out,
    costOfQ(q).toFixed(4),
    q.error,
    q.flags ? "yes" : "",
    (q.flags || []).join(" | "),
  ]),
];
const csvPath = join(LOG_DIR, `review-${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(csvPath, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
console.log(`\nCSV for Excel: ${csvPath}`);

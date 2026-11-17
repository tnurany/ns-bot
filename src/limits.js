/**
 * Spend limits per person, with department defaults.
 *
 * limits.jsonc (or LIMITS_FILE), dollars per person. JSON with // comments,
 * so the file can carry its own instructions and every department can sit
 * there commented out until it needs its own numbers:
 *
 *   { "company":     { "4h": 2, "week": 10, "month": 30 },
 *     "departments": {
 *       "IT_default": { "match": ["IT", "Information Technology"], "4h": 2, "week": 10, "month": 30 },
 *       "Purchasing": { "4h": 2, "week": 10, "month": 30 } },
 *     "people":      { "someone@tommycarwash.com": { "week": 25 } } }
 *
 * Three tiers. "company" covers everyone the other tiers do not: people
 * with no department and departments with no entry. A department entry
 * matches its own key, or the Entra spellings under "match", since one
 * team is often spelled several ways in Entra. "people" overrides any
 * window for one person, keyed by email or Entra object ID. A missing
 * window means no limit; 0 blocks.
 * The 4-hour window is rolling. The week starts Monday 00:00 and the month
 * on the 1st, in the server's local time (TZ).
 *
 * Spend is the list-price cost of each answered question (src/cost.js),
 * rebuilt from the question log at startup and kept in memory after that.
 * The check runs before a question goes to Claude, so a person can go over
 * by at most one question.
 *
 * The file is reread when it changes, so an edit needs no restart. The
 * Teams "limit set" command writes the same file through jsonc-parser's
 * edit API, so the comments survive; the command log is the audit trail.
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { costOf } from "./cost.js";
import { readEntries } from "./log.js";

export const LIMITS_FILE =
  process.env.LIMITS_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "limits.jsonc");

export const WINDOWS = ["4h", "week", "month"];
const LABEL = { "4h": "the last 4 hours", week: "this week", month: "this month" };
const TITLE = { "4h": "Last 4 hours", week: "This week", month: "This month" };
const NAME = { "4h": "4-hour", week: "weekly", month: "monthly" };
// A note goes on the end of the answer that carries usage past one of these.
const THRESHOLDS = [75, 90, 95, 100];
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const KEEP_DAYS = 35; // any calendar month, plus the week that may start before it

const money = (n) => `$${Number(n).toFixed(2)}`;
const when = (ms) =>
  new Date(ms).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------- the limits file ----------

let file = { text: "", raw: null, config: null, mtime: 0 };

// Trailing commas are allowed so commenting out the last entry of a section
// does not break the file.
const PARSE = { allowTrailingComma: true };
const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } };

function parseLimits(text) {
  const errors = [];
  const raw = parse(text, errors, PARSE);
  if (errors.length) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split("\n").length;
    throw new Error(`${printParseErrorCode(e.error)} at line ${line}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("the file is not a JSON object");
  return raw;
}

function normalize(raw) {
  const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v || {}]));
  // Entra department name (lowercased) -> { key, limits } of the entry that covers it.
  const departments = new Map();
  for (const [key, entry] of Object.entries(raw.departments || {})) {
    const { match, ...limits } = entry || {};
    for (const name of match?.length ? match : [key]) {
      const n = String(name).toLowerCase();
      if (departments.has(n)) {
        console.error(`\x1b[33m[limits] "${name}" is under both ${departments.get(n).key} and ${key}; using ${departments.get(n).key}\x1b[0m`);
      } else departments.set(n, { key, limits });
    }
  }
  return { company: raw.company || raw.default || {}, departments, people: lower(raw.people) };
}

function load() {
  let mtime;
  try {
    mtime = statSync(LIMITS_FILE).mtimeMs;
  } catch {
    throw new Error(
      `No spend limits file at ${LIMITS_FILE}.\n` +
        "Copy limits.jsonc from the repo there, or point LIMITS_FILE in .env at it."
    );
  }
  if (file.config && mtime === file.mtime) return file.config;
  try {
    const text = readFileSync(LIMITS_FILE, "utf8");
    const raw = parseLimits(text);
    file = { text, raw, config: normalize(raw), mtime };
  } catch (err) {
    // A typo in a hand-edited file must neither take the bot down nor
    // lift the limits: keep the last good version and say so once.
    if (!file.config) throw new Error(`Could not read ${LIMITS_FILE}: ${err.message}`);
    console.error(`\x1b[31m[limits] ${LIMITS_FILE} has a syntax error (${err.message}); keeping the last good version\x1b[0m`);
    file.mtime = mtime;
  }
  return file.config;
}

/** The three limits that apply to a person, and where they came from. */
export function limitsFor(who) {
  const cfg = load();
  const entry = cfg.departments.get((who.department || "").toLowerCase());
  const base = entry ? entry.limits : cfg.company;
  const overrides = {
    ...(who.email && cfg.people[who.email.toLowerCase()]),
    ...(who.id && cfg.people[who.id.toLowerCase()]),
  };
  const limits = {};
  for (const w of WINDOWS) limits[w] = overrides[w] ?? base[w] ?? null;
  return { limits, source: entry ? entry.key : "company", overrides };
}

// ---------- the ledger ----------

const ledger = []; // { key, at, cost } per answered question
const people = new Map(); // key -> who, as last seen
const keyOf = (who) => who.id || who.teamsId || who.name || "unknown";

function add(who, cost, at) {
  const key = keyOf(who);
  ledger.push({ key, at, cost });
  people.set(key, { ...people.get(key), ...who, lastSeen: at });
}

/** Rebuilds the ledger from the question log. Returns how many answers it holds. */
export function loadLedger() {
  for (const e of readEntries(KEEP_DAYS)) {
    if (e.kind !== "question" || !e.tokens) continue;
    add(e.who || {}, e.cost ?? costOf(e.tokens), Date.parse(e.at));
  }
  return ledger.length;
}

export function record(who, cost, at = Date.now()) {
  add(who, cost, at);
  if (ledger.length % 500 === 0) {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (let i = ledger.length - 1; i >= 0; i--) if (ledger[i].at < cutoff) ledger.splice(i, 1);
  }
}

function windowStart(w, now) {
  if (w === "4h") return now - FOUR_HOURS;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (w === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  else d.setDate(1);
  return d.getTime();
}

function windowReset(w, now) {
  const d = new Date(windowStart(w, now));
  if (w === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

const inWindow = (key, w, now) => ledger.filter((e) => e.key === key && e.at >= windowStart(w, now));
const spentIn = (key, w, now) => inWindow(key, w, now).reduce((s, e) => s + e.cost, 0);

// Percent of a limit used, as a whole number capped at 100. A limit of 0 is
// always fully used.
const percent = (spent, limit) => (limit > 0 ? Math.min(100, Math.floor((spent / limit) * 100)) : 100);
const resetTime = (key, w, limit, now) => (w === "4h" ? freesAt(key, limit, now) : windowReset(w, now));

// The rolling window frees up when enough of its oldest answers age out.
function freesAt(key, limit, now) {
  const rows = inWindow(key, "4h", now).sort((a, b) => a.at - b.at);
  let running = rows.reduce((s, e) => s + e.cost, 0);
  for (const e of rows) {
    running -= e.cost;
    if (running < limit) return e.at + FOUR_HOURS;
  }
  return now + FOUR_HOURS;
}

/** null when the person may ask, else the exceeded window that resets last. */
export function check(who, now = Date.now()) {
  const { limits } = limitsFor(who);
  const key = keyOf(who);
  let worst = null;
  for (const w of WINDOWS) {
    const limit = limits[w];
    if (limit == null) continue;
    const spent = spentIn(key, w, now);
    if (spent < limit) continue;
    const resetsAt = w === "4h" ? freesAt(key, limit, now) : windowReset(w, now);
    if (!worst || resetsAt > worst.resetsAt) worst = { window: w, limit, spent, resetsAt };
  }
  return worst;
}

/**
 * Charges an answered question to the person and returns a note for the
 * end of the answer when that pushed any window past 75, 90, 95 or 100
 * percent, else null. Percentages only: people do not see dollar amounts.
 */
export function charge(who, cost, now = Date.now()) {
  if (!cost) return null;
  const { limits } = limitsFor(who);
  const key = keyOf(who);
  const before = Object.fromEntries(WINDOWS.map((w) => [w, spentIn(key, w, now)]));
  add(who, cost, now);
  const crossed = WINDOWS.filter((w) => {
    if (limits[w] == null) return false;
    const was = (before[w] / (limits[w] || 1)) * 100;
    const is = ((before[w] + cost) / (limits[w] || 1)) * 100;
    return THRESHOLDS.some((t) => is >= t && was < t);
  });
  if (!crossed.length) return null;
  const parts = crossed.map((w) => {
    const pct = percent(before[w] + cost, limits[w]);
    return `${pct}% of your ${NAME[w]} limit${w === "4h" || pct >= 100 ? "" : ` (resets ${when(windowReset(w, now))})`}`;
  });
  let note = `Budget: you've used ${parts.join(" and ")}.`;
  const full = crossed.filter((w) => percent(before[w] + cost, limits[w]) >= 100);
  if (full.length) {
    const until = Math.max(...full.map((w) => resetTime(key, w, limits[w], now)));
    note += ` New questions wait until ${when(until)}.`;
  }
  return note;
}

export function blockedMessage(over) {
  return (
    `You've reached your NS Bot budget for ${LABEL[over.window]} (${money(over.limit)}). ` +
    `You can ask again after ${when(over.resetsAt)}. Type **budget** to see your usage.`
  );
}

/**
 * Usage against all three limits, as a Teams message. People see
 * percentages; admins (dollars: true) also see the amounts they set.
 */
export function report(who, now = Date.now(), { title = "Your NS Bot budget", dollars = false } = {}) {
  const { limits, source, overrides } = limitsFor(who);
  const key = keyOf(who);
  const lines = WINDOWS.map((w) => {
    const limit = limits[w];
    const spent = spentIn(key, w, now);
    const reset = w === "4h" ? "" : `, resets ${when(windowReset(w, now))}`;
    if (limit == null) return `- ${TITLE[w]}: no limit${dollars ? ` (${money(spent)} used)` : ""}`;
    const used = dollars ? `${money(spent)} of ${money(limit)} (${percent(spent, limit)}%)` : `${percent(spent, limit)}% used`;
    return `- ${TITLE[w]}: ${used}${reset}`;
  });
  const custom = WINDOWS.filter((w) => overrides[w] != null);
  const basis = (source === "company" ? "company-wide limits" : `${source} limits`) + (custom.length ? `, custom ${custom.join(", ")}` : "");
  return `**${title}** (${basis})\n${lines.join("\n")}`;
}

/** One line for the startup log. Throws when the file is missing or broken. */
export function describe() {
  const cfg = load();
  const fmt = (l) => WINDOWS.map((w) => (l[w] == null ? "none" : money(l[w]))).join(" / ");
  return (
    `Spend limits from ${LIMITS_FILE}: company-wide ${fmt(cfg.company)} per 4h / week / month, ` +
    `${Object.keys(file.raw.departments || {}).length} department entries covering ${cfg.departments.size} Entra names, ` +
    `${Object.keys(cfg.people).length} people with custom limits; ` +
    `${ADMINS.length} admins (LIMIT_ADMINS)`
  );
}

// ---------- admin commands ----------

const ADMINS = (process.env.LIMIT_ADMINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const isAdmin = (who) =>
  ADMINS.includes((who.email || "").toLowerCase()) || ADMINS.includes((who.id || "").toLowerCase());

const ADMIN_HELP =
  "Spend limit commands:\n" +
  "- `limit <email>`: that person's usage and limits\n" +
  "- `limit set <email> <4h|week|month> <dollars>`: a custom limit, or `default` to remove one\n" +
  "- `limit clear <email>`: remove all of that person's custom limits\n\n" +
  "Company-wide and department limits live in limits.jsonc. An Entra object ID works in place of the email.";

const WINDOW_ALIASES = { "4h": "4h", "4hr": "4h", "4hrs": "4h", "4hour": "4h", "4hours": "4h", week: "week", weekly: "week", month: "month", monthly: "month" };

function findPerson(target) {
  const t = target.toLowerCase();
  for (const p of people.values()) {
    if ((p.email || "").toLowerCase() === t || (p.id || "").toLowerCase() === t) return p;
  }
  return null;
}

// Sets (or, with undefined, removes) one value under "people" by editing the
// file text in place: comments and layout stay as the owner wrote them.
function writePerson(path, value) {
  load();
  let text = applyEdits(file.text, modify(file.text, ["people", ...path], value, FORMAT));
  // Removing someone's last custom window leaves "key": {}; drop the key too.
  const raw = parseLimits(text);
  const key = path[0];
  if (value === undefined && raw.people?.[key] && !Object.keys(raw.people[key]).length) {
    text = applyEdits(text, modify(text, ["people", key], undefined, FORMAT));
  }
  writeFileSync(LIMITS_FILE, text);
  const parsed = parseLimits(text);
  file = { text, raw: parsed, config: normalize(parsed), mtime: statSync(LIMITS_FILE).mtimeMs };
}

/** Handles everything after the word "limit". Returns the reply. */
export function adminCommand(who, args) {
  if (!ADMINS.length) return "No NS Bot admins are configured. Add LIMIT_ADMINS (emails or Entra object IDs) to .env.";
  if (!isAdmin(who)) return "Only NS Bot admins can view or change spend limits.";

  const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
  if (!verb) return ADMIN_HELP;

  if (verb.toLowerCase() === "set") {
    const [target, windowArg, amountArg] = rest;
    const w = WINDOW_ALIASES[(windowArg || "").toLowerCase()];
    if (!target || !w || !amountArg) return `Usage: \`limit set <email> <4h|week|month> <dollars|default>\`\n\n${ADMIN_HELP}`;
    const key = target.toLowerCase();
    const before = limitsFor(findPerson(key) || { email: key, id: key }).limits[w];
    if (amountArg.toLowerCase() === "default") {
      writePerson([key, w], undefined);
    } else {
      const amount = Number(amountArg.replace(/^\$/, ""));
      if (!Number.isFinite(amount) || amount < 0) return `"${amountArg}" is not a dollar amount. Example: \`limit set ${target} week 25\``;
      writePerson([key, w], amount);
    }
    const person = findPerson(key);
    const after = limitsFor(person || { email: key, id: key }).limits[w];
    const changed = `${TITLE[w]} limit for ${target}: ${before == null ? "none" : money(before)} -> ${after == null ? "none" : money(after)}.`;
    return person ? `${changed}\n\n${report(person, Date.now(), { title: `${person.name || target}'s NS Bot budget`, dollars: true })}` : `${changed}\n\nThey have not asked anything in the last ${KEEP_DAYS} days; it applies from their first question.`;
  }

  if (verb.toLowerCase() === "clear") {
    const target = rest[0];
    if (!target) return `Usage: \`limit clear <email>\``;
    const key = target.toLowerCase();
    const had = Boolean(load().people[key]);
    if (had) writePerson([key], undefined);
    return had ? `Removed the custom limits for ${target}; department defaults apply.` : `${target} had no custom limits.`;
  }

  const person = findPerson(verb);
  if (!person) return `I have not seen ${verb} ask anything in the last ${KEEP_DAYS} days. Use their email as it appears in the review CSV, or their Entra object ID.`;
  return report(person, Date.now(), { title: `${person.name || verb}'s NS Bot budget`, dollars: true });
}

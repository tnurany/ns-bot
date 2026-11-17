/**
 * Lists every department in Entra ID with its headcount, spelled the way
 * Entra spells it, in the syntax limits.jsonc uses, so new departments can
 * be pasted in commented out like the rest.
 *
 *   npm run departments
 *
 * Goes through the bot's app registration like the lookup in directory.js,
 * so it needs the same Graph permission, User.Read.All.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { App } from "@microsoft/teams.apps";
import { LIMITS_FILE } from "./limits.js";
import { PERMISSION_HINT } from "./directory.js";

const missing = ["TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET", "TEAMS_TENANT_ID"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")} in .env. The Entra lookup signs in as the bot's app registration.`);
  process.exit(1);
}

const app = new App({
  clientId: process.env.TEAMS_CLIENT_ID,
  clientSecret: process.env.TEAMS_CLIENT_SECRET,
  tenantId: process.env.TEAMS_TENANT_ID,
});

const counts = new Map();
let people = 0;
let url = "/users?$select=department,userType,accountEnabled&$top=999";
try {
  while (url) {
    const { data } = await app.graph.http.get(url, { timeout: 30000 });
    for (const u of data.value) {
      // Guests and disabled accounts cannot open the bot.
      if (!u.accountEnabled || u.userType !== "Member") continue;
      people++;
      const d = (u.department || "").trim() || "(no department)";
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    url = data["@odata.nextLink"] || null; // Graph pages at 999 users
  }
} catch (err) {
  const status = err?.response?.status ?? err?.statusCode;
  if (status === 403 || status === 401) {
    console.error(`Microsoft Graph returned ${status}.\n${PERMISSION_HINT}`);
  } else {
    console.error(`Could not list users: ${err.message}`);
  }
  process.exit(1);
}

let limits = { company: {}, departments: {} };
try {
  limits = parse(readFileSync(LIMITS_FILE, "utf8"), [], { allowTrailingComma: true }) || limits;
} catch {
  /* no file yet: every department is new */
}
// Entra spelling (lowercased) -> the limits.json entry that covers it
const listed = new Map();
for (const [key, entry] of Object.entries(limits.departments || {})) {
  for (const name of entry?.match?.length ? entry.match : [key]) listed.set(String(name).toLowerCase(), key);
}

const B = "\x1b[1m", D = "\x1b[90m", X = "\x1b[0m";
console.log(`\n${B}${counts.size} departments across ${people} enabled members${X}\n`);
const rows = [...counts].sort((a, b) => b[1] - a[1]);
for (const [d, n] of rows) {
  const key = listed.get(d.toLowerCase());
  console.log(`  ${String(n).padStart(4)}  ${d}${key ? `  ${D}${key === d ? "in limits.json" : `covered by ${key}`}${X}` : ""}`);
}

const fresh = rows.filter(([d]) => d !== "(no department)" && !listed.has(d.toLowerCase()));
if (fresh.length) {
  const c = limits.company || { "4h": 2, week: 10, month: 30 };
  const def = `{ "4h": ${c["4h"] ?? 2}, "week": ${c.week ?? 10}, "month": ${c.month ?? 30} }`;
  console.log(`\n${B}Not in ${LIMITS_FILE}${X} ${D}(they get the company-wide limits; paste into "departments" and remove the // from any that should differ)${X}\n`);
  for (const [d, n] of fresh) {
    const entry = `    // ${JSON.stringify(d)}: ${def},`;
    console.log(`${entry.padEnd(78)} // ${n} ${n === 1 ? "person" : "people"}`);
  }
}
console.log(`\n${D}People with no department get the company-wide limits. Names match case-insensitively.${X}`);
process.exit(0);

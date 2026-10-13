/**
 * Preflight. Verifies .env, the Anthropic key, and the NetSuite MCP endpoint
 * without spending much.
 *
 *   npm run check
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canRefresh, refreshAccessToken, secondsUntilExpiry, tokenUrl } from "./token.js";

const ok = (m) => console.log(`\x1b[32m  PASS\x1b[0m  ${m}`);
const warn = (m, hint) => {
  console.log(`\x1b[33m  WARN\x1b[0m  ${m}`);
  if (hint) console.log(`        ${hint}`);
};
const bad = (m, hint) => {
  console.log(`\x1b[31m  FAIL\x1b[0m  ${m}`);
  if (hint) console.log(`        ${hint}`);
  failures++;
};
let failures = 0;

console.log("\nEnvironment");
for (const k of ["ANTHROPIC_API_KEY", "NS_ACCOUNT", "NS_MCP_URL", "NS_ACCESS_TOKEN"]) {
  const v = process.env[k];
  if (!v) bad(`${k} is not set`, "Copy .env.example to .env and fill it in");
  else if (v.includes("1234567") || v.includes("xxxx"))
    bad(`${k} still holds a placeholder`, "Replace it with your real value");
  else ok(`${k} is set`);
}

if (process.env.NS_ACCOUNT && process.env.NS_ACCOUNT.includes("_")) {
  bad(
    "NS_ACCOUNT contains an underscore",
    "In hostnames it becomes a hyphen and lowercases: 1234567_SB1 -> 1234567-sb1"
  );
}

// Warnings, not failures: a valid access token works fine without these, it
// just stops working in an hour with no way to renew itself.
for (const k of ["NS_CLIENT_ID", "NS_CLIENT_SECRET", "NS_REFRESH_TOKEN"]) {
  process.env[k] ? ok(`${k} is set`) : warn(`${k} is not set`, "Without it there is no auto-refresh. The access token dies within an hour.");
}

const secs = secondsUntilExpiry();
if (secs === null) {
  warn("Access token expiry unknown (NS_TOKEN_EXPIRES_AT is empty)", "Recorded automatically on the next refresh or npm run pkce.");
} else if (secs <= 0) {
  warn(`Access token expired ${Math.ceil(-secs / 60)} min ago`, canRefresh() ? "Will auto-refresh on first use." : "Run: npm run pkce");
} else {
  ok(`Access token valid for ${Math.floor(secs / 60)} more min`);
}
if (process.env.NS_TOKEN_HOST) ok(`Token endpoint: ${tokenUrl()}`);

console.log("\nNode");
const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, "Need 20 or later");

if (failures) {
  console.log(`\n${failures} problem(s). Fix these before running network checks.\n`);
  process.exit(1);
}

console.log("\nAnthropic API");
try {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "Reply with: ok" }],
    }),
  });
  r.ok
    ? ok(`Reachable, model ${process.env.CLAUDE_MODEL || "claude-sonnet-5-5"} accepted`)
    : bad(`HTTP ${r.status}`, (await r.text()).slice(0, 300));
} catch (e) {
  bad("Network error", e.message);
}

console.log("\nNetSuite MCP");
// Reads the token at call time so the retry picks up the refreshed one.
const mcp = (method, params) =>
  fetch(process.env.NS_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NS_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const listTools = () => mcp("tools/list");
// The endpoint may answer as a one-event SSE stream rather than plain JSON.
const parseMcp = (text) => JSON.parse(text.replace(/^event:.*\ndata: /m, ""));
let mcpOk = false;

try {
  let r = await listTools();
  let refreshFailed = false;
  if (r.status === 401 && canRefresh()) {
    console.log("        401 from MCP endpoint. Refreshing token and retrying once.");
    try {
      const data = await refreshAccessToken();
      ok(`Token refreshed, valid ${data.expires_in}s${data.persisted ? ", written to .env" : ""}`);
      r = await listTools();
    } catch (e) {
      bad("Token refresh failed", e.message.replace(/\n/g, "\n        "));
      refreshFailed = true;
    }
  }
  const text = await r.text();
  if (refreshFailed) {
    // Already reported; the 401 below would only repeat it less usefully.
  } else if (!r.ok) {
    bad(
      `HTTP ${r.status}`,
      r.status === 401
        ? canRefresh()
          ? "Rejected even after refresh. Check the MCP role has MCP Server Connection, or run: npm run pkce"
          : "Token expired and auto-refresh is not configured. Run: npm run pkce"
        : text.slice(0, 300)
    );
  } else {
    const json = parseMcp(text);
    const tools = json?.result?.tools || [];
    ok(`${tools.length} tools available`);
    mcpOk = true;
    const writable = tools.filter((t) => t.annotations?.readOnlyHint === false);
    if (writable.length) {
      console.log(
        `\x1b[33m  WARN\x1b[0m  ${writable.length} write tool(s) enabled: ${writable
          .map((t) => t.name)
          .join(", ")}`
      );
      console.log("        Read-only is the safety argument for this project.");
      console.log("        Remove REST Web Services from the MCP role to disable them.");
    } else {
      ok("All tools are read-only");
    }
    console.log(`        ${tools.map((t) => t.name).join(", ")}`);
  }
} catch (e) {
  bad("Network or parse error", e.message);
}

// The bot runs a search named in prompts/ without looking it up first. One
// that was deleted, given a new ID, or created in production after the last
// sandbox refresh would only fail at answer time, so catch it here.
if (mcpOk) {
  console.log("\nSaved searches named in prompts/");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  const refs = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    for (const [id] of readFileSync(join(dir, f), "utf8").matchAll(/\bcustomsearch\w+/g)) {
      if (!refs.has(id)) refs.set(id, f);
    }
  }
  if (!refs.size) {
    ok("None named");
  } else {
    try {
      // Unfiltered, this is a few hundred KB. Fine here; never let the model
      // make this call without a query.
      const json = parseMcp(await (await mcp("tools/call", { name: "ns_listSavedSearches", arguments: {} })).text());
      if (json.error || json.result?.isError) throw new Error(JSON.stringify(json.error || json.result).slice(0, 300));
      const list = JSON.parse(json.result.content.map((c) => c.text).join(""));
      const titles = new Map(list.map((s) => [s.id, s.title]));
      for (const [id, file] of refs) {
        titles.has(id)
          ? ok(`${id} "${titles.get(id)}" (${file})`)
          : bad(
              `${id} not found (${file})`,
              "Deleted, given a new ID, not visible to the MCP role, or not in this account yet\n" +
                "        (searches created in production after the last sandbox refresh)."
            );
      }
    } catch (e) {
      bad("Could not list saved searches", e.message);
    }
  }
}

console.log(failures ? `\n${failures} problem(s).\n` : "\nAll checks passed. Try: npm run ask -- \"How many subsidiaries do we have?\"\n");
process.exit(failures ? 1 : 0);

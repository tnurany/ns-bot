/**
 * NetSuite token lifecycle: refresh, persist, and report expiry.
 *
 * Deliberately does not import config.js. config.js validates the Anthropic
 * key at import, and pkce.js and check.js need this module without that.
 * Everything here reads process.env live, because a refresh rewrites it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

// Refresh this far ahead of expiry so a token cannot die mid-request. A
// request with several SuiteQL tool calls can run well past a minute.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * Oracle's docs disagree on which host serves the token endpoint, so it is
 * overridable. If suitetalk.api returns 404, set NS_TOKEN_HOST to
 * <account>.app.netsuite.com.
 */
export function tokenUrl() {
  const host =
    process.env.NS_TOKEN_HOST || `${process.env.NS_ACCOUNT}.suitetalk.api.netsuite.com`;
  return `https://${host}/services/rest/auth/oauth2/v1/token`;
}

export function canRefresh() {
  return Boolean(
    process.env.NS_CLIENT_ID && process.env.NS_CLIENT_SECRET && process.env.NS_REFRESH_TOKEN
  );
}

/** Seconds until the access token expires, or null if unknown. */
export function secondsUntilExpiry() {
  const at = Number(process.env.NS_TOKEN_EXPIRES_AT);
  if (!at) return null;
  return Math.floor((at - Date.now()) / 1000);
}

function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  // Function replacer so a "$" in a token is not read as a backreference.
  return re.test(text) ? text.replace(re, () => line) : `${text.trimEnd()}\n${line}\n`;
}

/**
 * Writes a token response to process.env and .env. Used by both the refresh
 * grant and the initial authorization_code exchange in pkce.js.
 * Returns false if there was no .env to write to.
 */
export function saveTokens(data) {
  const updates = { NS_ACCESS_TOKEN: data.access_token };
  // NetSuite sometimes sends expires_in as a string.
  const expiresIn = Number(data.expires_in) || 3600;
  updates.NS_TOKEN_EXPIRES_AT = String(Date.now() + expiresIn * 1000);
  // Each refresh issues a new refresh token and the old one dies immediately.
  // Losing the new one means redoing the browser flow.
  if (data.refresh_token) updates.NS_REFRESH_TOKEN = data.refresh_token;

  Object.assign(process.env, updates);

  if (!existsSync(envPath)) return false;
  let env = readFileSync(envPath, "utf8");
  for (const [k, v] of Object.entries(updates)) env = setVar(env, k, v);
  writeFileSync(envPath, env);
  return true;
}

export async function refreshAccessToken() {
  if (!canRefresh()) {
    throw new Error(
      "Cannot refresh: need NS_CLIENT_ID, NS_CLIENT_SECRET and NS_REFRESH_TOKEN in .env.\n" +
        "If you have never authorized, run: npm run pkce"
    );
  }

  const basic = Buffer.from(
    `${process.env.NS_CLIENT_ID}:${process.env.NS_CLIENT_SECRET}`
  ).toString("base64");

  let res;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: process.env.NS_REFRESH_TOKEN,
      }),
    });
  } catch (e) {
    throw new Error(
      `Token refresh could not reach ${tokenUrl()}: ${e.message}\n` +
        "Check NS_ACCOUNT (hyphen, lowercase) and NS_TOKEN_HOST if set."
    );
  }

  const body = await res.text();

  if (!res.ok) {
    let hint = "";
    if (body.includes("invalid_grant")) {
      hint =
        "\ninvalid_grant almost always means the refresh token is older than\n" +
        "7 days (a hard NetSuite ceiling). Run: npm run pkce  and redo the browser flow.";
    } else if (res.status === 404) {
      hint =
        "\n404 means the wrong host. Oracle's docs disagree on which host serves\n" +
        "the token endpoint. Add to .env:\n" +
        `  NS_TOKEN_HOST=${process.env.NS_ACCOUNT}.app.netsuite.com`;
    } else if (res.status === 401) {
      hint = "\n401 here means NS_CLIENT_ID or NS_CLIENT_SECRET is wrong.";
    }
    const err = new Error(`Token refresh failed (HTTP ${res.status}): ${body.slice(0, 300)}${hint}`);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(body);
  const persisted = saveTokens(data);
  return { ...data, persisted };
}

let inFlight = null;

/**
 * Refreshes only if the token expires within 2 minutes. With no recorded
 * expiry it does nothing and lets the 401 retry in claude.js catch a dead
 * token; the first refresh after that records NS_TOKEN_EXPIRES_AT.
 */
export async function ensureFreshToken() {
  const secs = secondsUntilExpiry();
  if (secs === null || secs * 1000 > REFRESH_MARGIN_MS || !canRefresh()) return false;
  // Two concurrent refreshes would each spend the same refresh token, and
  // the second would fail with invalid_grant.
  inFlight ??= refreshAccessToken().finally(() => (inFlight = null));
  await inFlight;
  return true;
}

/**
 * NetSuite OAuth: the authorization code flow pieces, token requests, and
 * the bot's shared login in .env (refresh, persist, report expiry). The
 * Teams sign-in (signin.js, user-tokens.js) reuses the flow pieces for each
 * person's own login.
 *
 * Deliberately does not import config.js. config.js validates the Anthropic
 * key at import, and pkce.js and check.js need this module without that.
 * Everything here reads process.env live, because a refresh rewrites it.
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

// Refresh this far ahead of expiry so a token cannot die mid-request. A
// request with several SuiteQL tool calls can run well past a minute.
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;

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
  // For our confidential client a refresh returns no new refresh token, so
  // this only fires on the initial exchange. Kept for the day NetSuite sends
  // one on refresh: losing it would mean redoing the browser flow.
  if (data.refresh_token) updates.NS_REFRESH_TOKEN = data.refresh_token;

  Object.assign(process.env, updates);

  if (!existsSync(envPath)) return false;
  let env = readFileSync(envPath, "utf8");
  for (const [k, v] of Object.entries(updates)) env = setVar(env, k, v);
  writeFileSync(envPath, env);
  return true;
}

/** PKCE values. NetSuite requires PKCE for the mcp scope, S256 only. */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Step one of the authorization code flow: the URL the person opens. */
export function authorizeUrl({ redirectUri, state, challenge }) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: process.env.NS_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "mcp", // must be alone: NetSuite rejects mcp combined with other scopes
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${process.env.NS_ACCOUNT}.app.netsuite.com/app/login/oauth2/authorize.nl?${query}`;
}

const INVALID_GRANT_HINT = {
  refresh_token:
    "\ninvalid_grant on a refresh means the refresh token is past NetSuite's 7-day\n" +
    "ceiling, counted from sign-in (refreshing does not extend it), or was revoked.",
  authorization_code:
    "\ninvalid_grant on a code exchange means the code expired (codes last minutes\n" +
    "and work once), the PKCE verifier does not match, or redirect_uri differs\n" +
    "from the authorize request character for character.",
};

/**
 * POST to the token endpoint, for both grants: authorization_code (sign-in)
 * and refresh_token. NetSuite wants the client credentials of a confidential
 * client in an HTTP Basic header. Throws an error whose message says what to
 * check; err.invalidGrant marks a dead code or refresh token.
 */
export async function requestToken(params) {
  if (!process.env.NS_CLIENT_ID || !process.env.NS_CLIENT_SECRET) {
    throw new Error("Need NS_CLIENT_ID and NS_CLIENT_SECRET in .env, from the integration record.");
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
      body: new URLSearchParams(params),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the NetSuite token endpoint ${tokenUrl()}: ${e.message}\n` +
        "Check NS_ACCOUNT (hyphen, lowercase) and NS_TOKEN_HOST if set."
    );
  }

  const body = await res.text();

  if (!res.ok) {
    const invalidGrant = body.includes("invalid_grant");
    let hint = "";
    if (invalidGrant) {
      hint = INVALID_GRANT_HINT[params.grant_type] || "";
    } else if (res.status === 404) {
      hint =
        "\n404 means the wrong host. Oracle's docs disagree on which host serves\n" +
        "the token endpoint. Add to .env:\n" +
        `  NS_TOKEN_HOST=${process.env.NS_ACCOUNT}.app.netsuite.com`;
    } else if (res.status === 401) {
      hint = "\n401 here means NS_CLIENT_ID or NS_CLIENT_SECRET is wrong.";
    }
    const err = new Error(
      `NetSuite token request (${params.grant_type}) failed (HTTP ${res.status}): ${body.slice(0, 300)}${hint}`
    );
    err.status = res.status;
    err.invalidGrant = invalidGrant;
    throw err;
  }

  return JSON.parse(body);
}

/**
 * NetSuite access tokens are JWTs whose sub is "<role id>;<entity id>": which
 * role the person picked when signing in, and who they are. Read without
 * checking the signature, which is fine for display and logging; NetSuite
 * checks it on every call.
 */
export function tokenClaims(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split(".")[1], "base64url"));
    const [role, entity] = String(payload.sub || "").split(";");
    return { role: role || null, entity: entity || null };
  } catch {
    return { role: null, entity: null };
  }
}

/** Refreshes the bot's shared login in .env. */
export async function refreshAccessToken() {
  if (!canRefresh()) {
    throw new Error(
      "Cannot refresh: need NS_CLIENT_ID, NS_CLIENT_SECRET and NS_REFRESH_TOKEN in .env.\n" +
        "If you have never authorized, run: npm run pkce"
    );
  }
  let data;
  try {
    data = await requestToken({ grant_type: "refresh_token", refresh_token: process.env.NS_REFRESH_TOKEN });
  } catch (err) {
    if (err.invalidGrant) err.message += "\nFor the bot's shared login, run: npm run pkce";
    throw err;
  }
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

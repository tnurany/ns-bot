/**
 * Each person's own NetSuite login, for the Teams bot.
 *
 * With a person's own token, NetSuite applies that person's role to every
 * query, so the bot cannot show anyone data their role cannot see. People who
 * have not signed in use the shared login in .env, unless NS_SIGNIN_REQUIRED
 * is set.
 *
 * The tokens are live credentials for someone's NetSuite access, so the file
 * is encrypted (AES-256-GCM) with NS_USER_TOKENS_KEY. Keyed by the Entra
 * object ID, which stays the same across devices and renamed accounts.
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requestToken, tokenClaims, REFRESH_MARGIN_MS } from "./token.js";

// When hosted, point this outside the deployed folder, or every deploy
// signs everyone out.
export const TOKENS_FILE =
  process.env.NS_USER_TOKENS_FILE ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "data", "user-tokens.enc");

// NetSuite's hard ceiling. For a confidential client a refresh returns a new
// access token but no new refresh token, so the 7 days count from sign-in
// however often the bot is used.
export const SIGNIN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Thrown when a person's login can no longer be used and they must sign in again. */
export class SignInRequired extends Error {}

let users = new Map(); // user key -> { accessToken, refreshToken, expiresAt, signedInAt, role, entity }
const inFlight = new Map();

/** Why the key is unusable, or null when it is fine. */
export function keyProblem() {
  const raw = process.env.NS_USER_TOKENS_KEY;
  if (raw && Buffer.from(raw, "base64").length === 32) return null;
  return (
    `NS_USER_TOKENS_KEY ${raw ? "is not 32 bytes of base64" : "is not set"}. It encrypts ` +
    "each person's NetSuite tokens on disk. Generate one with:\n" +
    `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\n` +
    "and add it to .env. Changing it later signs everyone out."
  );
}

const key = () => Buffer.from(process.env.NS_USER_TOKENS_KEY, "base64");

/**
 * Reads the file at startup. A file that will not decrypt is fatal: carrying
 * on with an empty list would overwrite it at the next sign-in.
 */
export function load() {
  if (!existsSync(TOKENS_FILE)) {
    users = new Map();
    return 0;
  }
  try {
    const box = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const json = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
    users = new Map(Object.entries(JSON.parse(json)));
    return users.size;
  } catch (err) {
    throw new Error(
      `Could not read ${TOKENS_FILE}: ${err.message}\n` +
        "Most likely NS_USER_TOKENS_KEY is not the key the file was written with.\n" +
        "Put the old key back, or delete the file: everyone then signs in again."
    );
  }
}

function save() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(users))), cipher.final()]);
  const box = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  // Write and rename, so a crash mid-write cannot leave a file that no
  // longer decrypts.
  const tmp = `${TOKENS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
  renameSync(tmp, TOKENS_FILE);
}

/** Stores the tokens from a completed sign-in. Throws if they cannot be saved. */
export function remember(userKey, data) {
  const { role, entity } = tokenClaims(data.access_token);
  const record = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    signedInAt: Date.now(),
    role,
    entity,
  };
  users.set(userKey, record);
  save();
  return record;
}

export function forget(userKey) {
  const had = users.delete(userKey);
  if (had) save();
  return had;
}

/**
 * "none": never signed in, or signed out. "expired": signed in once, but the
 * login is dead, so a question would fail; the record stays so the person
 * is asked to sign in again instead of quietly getting the shared login.
 * "ok": usable; `until` is when the 7 days run out.
 */
export function status(userKey) {
  const r = users.get(userKey);
  if (!r) return { state: "none" };
  const until = r.signedInAt + SIGNIN_LIFETIME_MS;
  const accessValid = Date.now() < r.expiresAt - REFRESH_MARGIN_MS;
  if (r.dead || (!accessValid && Date.now() >= until)) return { state: "expired", record: r };
  return { state: "ok", record: r, until };
}

/** The login claude.js uses for this person: a token now, and a forced refresh. */
export function loginFor(userKey) {
  return {
    kind: "user",
    userKey,
    async token() {
      const r = users.get(userKey);
      if (!r || r.dead) throw new SignInRequired("No usable NetSuite sign-in for this person.");
      if (Date.now() < r.expiresAt - REFRESH_MARGIN_MS) return r.accessToken;
      return refresh(userKey);
    },
    refresh: () => refresh(userKey),
  };
}

// Two questions at once from one person would otherwise refresh twice.
function refresh(userKey) {
  if (!inFlight.has(userKey)) {
    inFlight.set(userKey, refreshNow(userKey).finally(() => inFlight.delete(userKey)));
  }
  return inFlight.get(userKey);
}

async function refreshNow(userKey) {
  const r = users.get(userKey);
  if (!r || r.dead) throw new SignInRequired("No usable NetSuite sign-in for this person.");
  if (!r.refreshToken || Date.now() >= r.signedInAt + SIGNIN_LIFETIME_MS) {
    throw new SignInRequired("The 7-day NetSuite sign-in has run out.");
  }
  let data;
  try {
    data = await requestToken({ grant_type: "refresh_token", refresh_token: r.refreshToken });
  } catch (err) {
    // Revoked, or the 7 days counted differently than we think. Either way
    // only a new sign-in helps; marking it keeps the shared login out.
    if (err.invalidGrant) {
      r.dead = true;
      trySave();
      throw new SignInRequired(err.message);
    }
    throw err;
  }
  r.accessToken = data.access_token;
  r.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  // Not expected for our confidential client, but if NetSuite ever sends
  // one, the old one may stop working.
  if (data.refresh_token) r.refreshToken = data.refresh_token;
  trySave();
  return r.accessToken;
}

// After a refresh the new token is already in memory, so a failed write only
// matters after a restart, when the next refresh replaces it anyway.
function trySave() {
  try {
    save();
  } catch (err) {
    console.error(`\x1b[31m[sign-in] could not save ${TOKENS_FILE}:\x1b[0m ${err.message}`);
  }
}

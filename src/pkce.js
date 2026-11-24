/**
 * Generate PKCE values and print the NetSuite authorization URL.
 *
 *   npm run pkce
 *
 * Run this when you have no tokens, or when the refresh token has expired
 * (7 days after sign-in). It signs in the bot's shared login; people in
 * Teams sign in for themselves with "sign in" (src/signin.js).
 *
 * What PKCE is: you keep a random string (the verifier) and send only its
 * SHA-256 hash (the challenge) when you start. At token exchange you send the
 * original verifier, and NetSuite checks it hashes to what it stored. That
 * makes an intercepted authorization code useless on its own.
 */
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import "dotenv/config";
import { pkcePair, authorizeUrl, requestToken, saveTokens } from "./token.js";

const redirectUri = process.env.NS_REDIRECT_URI || "https://localhost/callback";

if (!process.env.NS_ACCOUNT || !process.env.NS_CLIENT_ID || !process.env.NS_CLIENT_SECRET) {
  console.error("Set NS_ACCOUNT, NS_CLIENT_ID and NS_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const { verifier, challenge } = pkcePair();
// NetSuite wants 22 to 1024 characters.
const state = crypto.randomBytes(16).toString("hex");
const authUrl = authorizeUrl({ redirectUri, state, challenge });

console.log("\n1. Open an INCOGNITO window. This matters: a normal window");
console.log("   reuses your Administrator session, and Oracle blocks the");
console.log("   Administrator role from MCP.\n");
console.log("2. Paste this URL:\n");
console.log(authUrl);
console.log("\n3. Sign in and SELECT YOUR MCP ROLE, not Administrator.");
console.log("4. Click Allow. The page will fail to load. That is expected.");
console.log("5. Copy the whole URL from the address bar and paste it below.\n");

const rl = readline.createInterface({ input: stdin, output: stdout });
const pasted = (await rl.question("Paste the failed URL: ")).trim();
rl.close();

let code, returnedState;
try {
  const u = new URL(pasted);
  code = u.searchParams.get("code");
  returnedState = u.searchParams.get("state");
} catch {
  console.error("That does not parse as a URL.");
  process.exit(1);
}

if (!code) {
  console.error("No 'code' parameter found in that URL.");
  process.exit(1);
}
if (returnedState !== state) {
  console.error("State mismatch. Start over. This is the CSRF check.");
  process.exit(1);
}

let data;
try {
  data = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}

if (saveTokens(data)) {
  console.log("\nTokens written to .env");
  console.log(`  expires_in: ${data.expires_in}s`);
  console.log("  Refresh is automatic from here, but only for 7 days: NetSuite does not");
  console.log("  extend the refresh token, so run npm run pkce again within a week.");
} else {
  console.log(JSON.stringify(data, null, 2));
}

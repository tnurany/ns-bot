/**
 * Generate PKCE values and print the NetSuite authorization URL.
 *
 *   npm run pkce
 *
 * Run this when you have no tokens, or when the refresh token has expired
 * (after 7 days). It does step 1 of the OAuth authorization code flow.
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
import { tokenUrl, saveTokens } from "./token.js";

const account = process.env.NS_ACCOUNT;
const clientId = process.env.NS_CLIENT_ID;
const clientSecret = process.env.NS_CLIENT_SECRET;
const redirectUri = process.env.NS_REDIRECT_URI || "https://localhost/callback";

if (!account || !clientId || !clientSecret) {
  console.error("Set NS_ACCOUNT, NS_CLIENT_ID and NS_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("hex");

const authUrl =
  `https://${account}.app.netsuite.com/app/login/oauth2/authorize.nl` +
  `?response_type=code` +
  `&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&scope=mcp` +
  `&state=${state}` +
  `&code_challenge=${challenge}` +
  `&code_challenge_method=S256`;

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

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

const res = await fetch(tokenUrl(), {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }),
});

const body = await res.text();

if (!res.ok) {
  console.error(`\nToken exchange failed (HTTP ${res.status}):\n${body}\n`);
  console.error(
    "invalid_grant usually means the code expired (they last minutes and are\n" +
      "single use) or the redirect_uri does not match the integration record\n" +
      "character for character. 404 means the wrong host: add\n" +
      `NS_TOKEN_HOST=${account}.app.netsuite.com to .env.`
  );
  process.exit(1);
}

const data = JSON.parse(body);

if (saveTokens(data)) {
  console.log("\nTokens written to .env");
  console.log(`  expires_in: ${data.expires_in}s`);
  console.log("  Refresh is automatic from here. The refresh token dies after 7 days");
  console.log("  without use, so run ask, chat or check at least once a week.");
} else {
  console.log(JSON.stringify(data, null, 2));
}

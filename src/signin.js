/**
 * Per-person NetSuite sign-in from Teams.
 *
 * Azure Bot Service's built-in OAuth connections cannot do this: NetSuite's
 * mcp scope requires PKCE and an HTTP Basic header at the token endpoint, and
 * the connections support neither. So the bot runs the same authorization
 * code flow as npm run pkce, with its own callback instead of a pasted URL:
 *
 *   1. "sign in" in a 1:1 chat sends a card with a NetSuite link. The link's
 *      state names the Teams user, works once and expires in 10 minutes.
 *   2. The person signs in to NetSuite, picks a role and clicks Allow.
 *   3. NetSuite redirects to NS_SIGNIN_REDIRECT_URI on this server. The
 *      callback swaps the code for tokens, checks the role can reach the AI
 *      connector, stores the tokens encrypted, and the bot confirms in Teams.
 *
 * NS_SIGNIN_REDIRECT_URI must be listed on the integration record exactly,
 * next to the https://localhost/callback that npm run pkce uses.
 */
import crypto from "node:crypto";
import { pkcePair, authorizeUrl, requestToken } from "./token.js";
import * as userTokens from "./user-tokens.js";

export const REDIRECT_URI = process.env.NS_SIGNIN_REDIRECT_URI || null;
export const REQUIRED = /^(1|true|yes)$/i.test(process.env.NS_SIGNIN_REQUIRED || "");

const LINK_TTL_MS = 10 * 60 * 1000;

// state -> { userKey, verifier, expires, onDone }. In memory: a restart voids
// open links, which only means asking for a new one.
const pending = new Map();

/**
 * Called once at startup. Returns whether sign-in is on. Throws when it is
 * half set up, because a bot that silently ignores NS_SIGNIN_REQUIRED would
 * answer everyone with the shared login.
 */
export function configure() {
  if (!REDIRECT_URI) {
    if (REQUIRED) {
      throw new Error("NS_SIGNIN_REQUIRED is set but NS_SIGNIN_REDIRECT_URI is not. Set both, or neither.");
    }
    return false;
  }
  let url;
  try {
    url = new URL(REDIRECT_URI);
  } catch {
    throw new Error(`NS_SIGNIN_REDIRECT_URI is not a URL: ${REDIRECT_URI}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `NS_SIGNIN_REDIRECT_URI must be https (NetSuite rejects http redirect URIs, even for localhost): ${REDIRECT_URI}`
    );
  }
  const problem = userTokens.keyProblem();
  if (problem) throw new Error(problem);
  userTokens.load();
  return true;
}

/** Path of the callback route on this server. */
export const callbackPath = () => new URL(REDIRECT_URI).pathname;

/**
 * A NetSuite sign-in URL for this person. Asking again voids their previous
 * link. `onDone` gets { ok: true, record } or { ok: false, message } when the
 * callback finishes.
 */
export function link(userKey, onDone) {
  for (const [state, p] of pending) {
    if (p.userKey === userKey || p.expires < Date.now()) pending.delete(state);
  }
  const { verifier, challenge } = pkcePair();
  // NetSuite wants 22 to 1024 characters; this is 32.
  const state = crypto.randomBytes(24).toString("base64url");
  pending.set(state, { userKey, verifier, expires: Date.now() + LINK_TTL_MS, onDone });
  return authorizeUrl({ redirectUri: REDIRECT_URI, state, challenge });
}

/** The Teams card with the link. */
export function card(url, intro) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: intro, wrap: true },
            {
              type: "TextBlock",
              text:
                "On the NetSuite page, pick the role you normally use (not Administrator) and click Allow. " +
                "The link works once and expires in 10 minutes. You will need to sign in again every 7 days.",
              wrap: true,
              isSubtle: true,
              size: "Small",
            },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Sign in to NetSuite", url }],
        },
      },
    ],
  };
}

/**
 * Handles NetSuite's redirect. Returns { status, html } for the browser tab;
 * the outcome reaches Teams through the link's onDone. Never throws.
 */
export async function callback(query) {
  const param = (k) => (typeof query[k] === "string" ? query[k] : "");
  const state = param("state");
  const p = pending.get(state);
  pending.delete(state); // single use, whatever happens next

  if (!p || p.expires < Date.now()) {
    return page(
      400,
      "This sign-in link has expired",
      "Sign-in links work once and last 10 minutes. Go back to Teams and say sign in for a new one."
    );
  }

  const finish = (result) => {
    try {
      p.onDone(result);
    } catch (err) {
      console.error("\x1b[31m[sign-in] could not report back to Teams:\x1b[0m", err.message);
    }
  };

  if (param("error")) {
    const cancelled = param("error") === "access_denied";
    const message = cancelled
      ? "Sign-in cancelled: NetSuite access was not allowed, so nothing changed."
      : `NetSuite ended the sign-in with "${param("error")}". Say **sign in** to try again.`;
    console.warn(`[sign-in] NetSuite returned error=${param("error")} ${param("error_description")}`);
    finish({ ok: false, message });
    return page(400, cancelled ? "Sign-in cancelled" : "Sign-in did not complete", stripMarkdown(message));
  }

  let data;
  try {
    data = await requestToken({
      grant_type: "authorization_code",
      code: param("code"),
      redirect_uri: REDIRECT_URI,
      code_verifier: p.verifier,
    });
  } catch (err) {
    console.error(`\x1b[31m[sign-in] code exchange failed:\x1b[0m ${err.message}`);
    const message = "NetSuite did not complete the sign-in. Say **sign in** to try again; if it keeps failing, let the bot's owner know.";
    finish({ ok: false, message });
    return page(502, "Sign-in did not complete", stripMarkdown(message));
  }

  const problem = await connectorProblem(data.access_token);
  if (problem) {
    finish({ ok: false, message: problem });
    return page(403, "This role cannot use NS Bot", stripMarkdown(problem));
  }

  let record;
  try {
    record = userTokens.remember(p.userKey, data);
  } catch (err) {
    console.error(`\x1b[31m[sign-in] could not save the tokens:\x1b[0m ${err.message}`);
    const message = "Signed in, but the bot could not save it. Let the bot's owner know.";
    finish({ ok: false, message });
    return page(500, "Sign-in could not be saved", message);
  }
  finish({ ok: true, record });
  return page(200, "Signed in to NetSuite", "You can close this tab and go back to Teams.");
}

/**
 * NetSuite issues a token for any role the person picks, including ones the
 * AI connector refuses (Administrator, or a role without MCP Server
 * Connection). Without this check the sign-in "works" and every question
 * fails. One tools/list call finds out now, while the person is still here.
 */
async function connectorProblem(accessToken) {
  let res;
  let text;
  try {
    res = await fetch(process.env.NS_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    text = await res.text();
  } catch (err) {
    // A network blip is not the role's fault; the first question will tell.
    console.warn(`[sign-in] could not check the AI connector: ${err.message}`);
    return null;
  }
  let rpcError = null;
  try {
    rpcError = JSON.parse(text.replace(/^event:.*\ndata: /m, "")).error || null;
  } catch {}
  if (res.ok && !rpcError) return null;

  console.error(`\x1b[31m[sign-in] AI connector refused the new token:\x1b[0m HTTP ${res.status} ${text.slice(0, 300)}`);
  return (
    "NetSuite signed you in, but the role you picked can't use the NetSuite AI connector. " +
    "If you picked Administrator, say **sign in** and pick your regular role: Oracle blocks Administrator. " +
    "Otherwise ask your NetSuite admin to add the MCP Server Connection permission to your role."
  );
}

const stripMarkdown = (s) => s.replace(/\*\*/g, "");

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(status, title, message) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NS Bot: ${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 16px;color:#222;background:#fff}
h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return { status, html };
}

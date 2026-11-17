/**
 * Department and email lookup for the question log.
 *
 * A Teams message carries the sender's display name and Entra object ID and
 * nothing else about them. The department and email on a Teams profile card
 * live in Entra ID, so the bot fetches it through Microsoft Graph, signed in as its
 * own app registration (the TEAMS_* credentials, via the SDK's app.graph).
 * That takes the Graph application permission User.Read.All with admin
 * consent. User.ReadBasic.All is not enough: its "basic profile" returns
 * department blank.
 *
 * A lookup must never cost an answer. Results are cached per person for a
 * day, a call is capped at a few seconds, and any failure leaves the
 * department and email null. A 403 means the permission is missing; that is reported
 * once, with the fix, not on every question.
 */
const CACHE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

export const PERMISSION_HINT =
  "The bot's app registration (TEAMS_CLIENT_ID) needs the Microsoft Graph application\n" +
  "permission User.Read.All, with admin consent:\n" +
  "  entra.microsoft.com > App registrations > the bot's app > API permissions >\n" +
  "  Add a permission > Microsoft Graph > Application permissions > User.Read.All,\n" +
  "  then Grant admin consent (a Global Administrator).\n" +
  "Questions are still logged, with no department.";

const status = (err) => err?.response?.status ?? err?.statusCode ?? null;
const denied = (err) => status(err) === 403 || status(err) === 401;

/** `graph` is the SDK's app.graph, or null to turn lookups off (local mode). */
export function createDirectory(graph) {
  const cache = new Map(); // object ID -> { department, email, until }
  let off = !graph;

  function turnOff(err) {
    off = true;
    console.error(
      `\x1b[31m[directory] Department lookup is off: Microsoft Graph returned ${status(err)}.\x1b[0m\n${PERMISSION_HINT}`
    );
  }

  return {
    /** Fills in `who.department` and `who.email`, from cache or Graph. Returns `who`. */
    async enrich(who) {
      if (off || !who.id) return who;
      const hit = cache.get(who.id);
      if (hit && hit.until > Date.now()) {
        who.department = hit.department;
        who.email = hit.email;
        return who;
      }
      try {
        const { data } = await graph.http.get(
          `/users/${encodeURIComponent(who.id)}?$select=department,mail,userPrincipalName`,
          { timeout: TIMEOUT_MS }
        );
        who.department = data?.department || null;
        // mail is the mailbox address; a user without a mailbox still has a UPN.
        who.email = data?.mail || data?.userPrincipalName || null;
        cache.set(who.id, { department: who.department, email: who.email, until: Date.now() + CACHE_MS });
      } catch (err) {
        if (denied(err)) turnOff(err);
        else {
          // A network blip, or an ID Graph does not know (a guest, say).
          // Retry later, not on every question.
          console.error(`\x1b[33m[directory] no department for ${who.name || who.id}: ${err.message}\x1b[0m`);
          cache.set(who.id, { department: null, email: null, until: Date.now() + RETRY_MS });
        }
      }
      return who;
    },

    /** One cheap call at startup, so a missing permission shows before the first question. */
    async probe() {
      if (off) return;
      try {
        await graph.http.get("/users?$top=1&$select=id", { timeout: TIMEOUT_MS });
        console.log("Department lookup through Microsoft Graph: on");
      } catch (err) {
        if (denied(err)) turnOff(err);
        else console.error(`\x1b[33m[directory] could not reach Microsoft Graph (${err.message}); will retry per question\x1b[0m`);
      }
    },
  };
}

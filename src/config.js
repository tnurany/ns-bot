import "dotenv/config";

function need(name) {
  const v = process.env[name];
  if (!v || v.startsWith("sk-ant-api03-xxxx") || v.includes("1234567")) {
    throw new Error(
      `Missing or placeholder value for ${name}. Edit your .env file.`
    );
  }
  return v;
}

// claude.js sends the mcp_toolset shape, which this revision introduced. The
// 2025-04-04 revision filtered tools a different way, and the API stopped
// accepting that filter, which silently exposed the write tools.
const betaHeader = process.env.MCP_BETA_HEADER || "mcp-client-2025-11-20";
if (betaHeader.includes("2025-04-04")) {
  throw new Error(
    "MCP_BETA_HEADER=mcp-client-2025-04-04 is the old MCP connector revision.\n" +
      "Set MCP_BETA_HEADER=mcp-client-2025-11-20 in .env, or delete the line."
  );
}

export const config = {
  anthropicKey: need("ANTHROPIC_API_KEY"),
  model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  betaHeader,

  nsAccount: need("NS_ACCOUNT"),
  nsMcpUrl: need("NS_MCP_URL"),
  // Getter, not a value: token.js rewrites process.env on refresh, and a
  // value captured at import would keep sending the dead token.
  get nsAccessToken() {
    return need("NS_ACCESS_TOKEN");
  },

  nsRedirectUri: process.env.NS_REDIRECT_URI || "https://localhost/callback",
};

export const nsAuthorizeUrl = () =>
  `https://${config.nsAccount}.app.netsuite.com/app/login/oauth2/authorize.nl`;

// The *_app tools render an interactive HTML picker. The Messages API cannot
// display it, and their own descriptions tell the model to WAIT for a user
// response that will never arrive. Excluding them prevents a stalled turn.
//
// The write tools appeared when the MCP role gained record permissions. This
// bot is read-only by design; blocking them here is a backstop, the real fix
// is removing the permission from the role.
export const BLOCKED_TOOLS = [
  "ns_prompt_library_app",
  "ns_report_filters_app",
  "ns_selector_app",
  "ns_createRecord",
  "ns_updateRecord",
];

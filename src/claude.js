import Anthropic from "@anthropic-ai/sdk";
import { config, BLOCKED_TOOLS } from "./config.js";
import { ensureFreshToken, refreshAccessToken, canRefresh } from "./token.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

/**
 * One call to Claude with the NetSuite MCP server attached.
 *
 * The MCP connector is a server-side feature: Anthropic's API connects to
 * NetSuite, runs the tool calls, and returns the results. You are not writing
 * an MCP client here.
 *
 * NOTE: the beta header value and the exact shape of tool_configuration have
 * changed across API revisions. If you get a 400, read the error text and
 * check the MCP connector page in the Anthropic docs. Both are configurable
 * from .env so you can adjust without touching this file.
 */
export async function askClaude(args) {
  await ensureFreshToken();
  try {
    return await sendOnce(args);
  } catch (err) {
    // Expiry can be unknown (no NS_TOKEN_EXPIRES_AT yet) or wrong (token
    // revoked early), so the proactive check is not enough on its own.
    if (!isNetSuiteAuthError(err) || !canRefresh()) throw err;
    console.warn("\n[info] NetSuite rejected the access token. Refreshing and retrying once.");
    await refreshAccessToken();
    return await sendOnce(args);
  }
}

// The Anthropic API reports MCP server auth failures in its own error, so
// distinguish them from a bad ANTHROPIC_API_KEY by what the message names.
function isNetSuiteAuthError(err) {
  const msg = String(err?.message || "").toLowerCase();
  if (msg.includes("x-api-key")) return false;
  const namesMcp = msg.includes("mcp") || msg.includes("netsuite");
  const namesAuth = /401|unauthori[sz]ed|authenticat|invalid[_ ]token|expired/.test(msg);
  return namesMcp && namesAuth;
}

async function sendOnce({ system, messages, maxTokens = 4000 }) {
  const mcpServer = {
    type: "url",
    url: config.nsMcpUrl,
    name: "netsuite",
    authorization_token: config.nsAccessToken,
  };

  // Allow-list everything except the interactive UI tools.
  if (BLOCKED_TOOLS.length) {
    mcpServer.tool_configuration = {
      enabled: true,
      blocked_tools: BLOCKED_TOOLS,
    };
  }

  try {
    return await client.beta.messages.create(
      {
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages,
        mcp_servers: [mcpServer],
      },
      { headers: { "anthropic-beta": config.betaHeader } }
    );
  } catch (err) {
    // If the API rejects tool_configuration, retry without it rather than
    // dying. The system prompt still tells the model to avoid those tools.
    const msg = String(err?.message || "");
    if (msg.includes("tool_configuration") || msg.includes("blocked_tools")) {
      console.warn(
        "\n[warn] tool_configuration rejected by the API. Retrying without it."
      );
      console.warn(
        "[warn] The two interactive app tools are now only excluded by the system prompt.\n"
      );
      delete mcpServer.tool_configuration;
      return await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: maxTokens,
          system,
          messages,
          mcp_servers: [mcpServer],
        },
        { headers: { "anthropic-beta": config.betaHeader } }
      );
    }
    throw err;
  }
}

/**
 * Prints text, tool calls, and tool results.
 *
 * Seeing the tool blocks is the point. They show you the exact SuiteQL Claude
 * wrote and exactly what NetSuite returned, which is how you learn what your
 * schema looks like to a model that has never seen it.
 */
export function printResponse(res, { verbose = true } = {}) {
  for (const b of res.content) {
    if (b.type === "text") {
      console.log("\n" + b.text);
    } else if (b.type === "mcp_tool_use" && verbose) {
      console.log("\n\x1b[36m[TOOL]\x1b[0m", b.name);
      const input = JSON.stringify(b.input, null, 2);
      console.log(input.length > 900 ? input.slice(0, 900) + "\n  ...(truncated)" : input);
    } else if (b.type === "mcp_tool_result" && verbose) {
      const out = JSON.stringify(b.content);
      console.log(
        "\x1b[90m[RESULT]\x1b[0m",
        out.length > 900 ? out.slice(0, 900) + " ...(truncated)" : out
      );
    }
  }
  const u = res.usage || {};
  console.log(
    `\n\x1b[90m[usage] in=${u.input_tokens} out=${u.output_tokens}` +
      (u.cache_read_input_tokens ? ` cache_read=${u.cache_read_input_tokens}` : "") +
      `\x1b[0m`
  );
}

export function explainError(err) {
  const status = err?.status;
  console.error("\n\x1b[31mRequest failed.\x1b[0m");
  console.error(err?.message || err);

  if (status === 401) {
    console.error(
      "\n401 means a credential was rejected.\n" +
        "  - If it names the Anthropic key, check ANTHROPIC_API_KEY in .env\n" +
        "  - If it names the MCP server, the NetSuite token was rejected even\n" +
        "    after an automatic refresh. Check the MCP role still has MCP Server\n" +
        "    Connection, or run: npm run pkce"
    );
  } else if (status === 400) {
    console.error(
      "\n400 usually means the request shape does not match the beta revision.\n" +
        "  - Try a different MCP_BETA_HEADER value in .env\n" +
        "  - Check the MCP connector page in the Anthropic docs for the current\n" +
        "    header and whether tool_configuration is still supported"
    );
  } else if (status === 429) {
    console.error("\n429 is a rate limit. Wait and retry.");
  }
}

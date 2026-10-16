import Anthropic from "@anthropic-ai/sdk";
import { config, BLOCKED_TOOLS } from "./config.js";
import { ensureFreshToken, refreshAccessToken, canRefresh } from "./token.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

// Thinking is on by default on current models and its tokens count against
// this cap, together with every SuiteQL call and the final answer. At 4,000 a
// question that paginates spent it all before writing a word. 16,000 is the
// most a non-streaming request should ask for before HTTP timeouts become a
// risk; going higher means switching to streaming.
const MAX_TOKENS = 16000;

// The MCP connector runs tool calls in a server-side loop that pauses after
// 10 iterations with stop_reason "pause_turn". A paginated query (metadata,
// then page after page) can need more. Each resume continues the same turn;
// this caps how long one question can run.
const MAX_RESUMES = 4;

/**
 * One question to Claude with the NetSuite MCP server attached, resumed
 * through any pause_turn stops. Returns a single response whose content is
 * the whole turn and whose usage is the total.
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
export async function askClaude({ system, messages, maxTokens = MAX_TOKENS }) {
  let res = await askOnce({ system, messages, maxTokens });
  const content = [...res.content];
  let inTokens = res.usage?.input_tokens || 0;
  let outTokens = res.usage?.output_tokens || 0;

  for (let i = 0; res.stop_reason === "pause_turn" && i < MAX_RESUMES; i++) {
    // Resend the turn so far as the assistant message, with no extra user
    // message. The API sees the unfinished tool loop and picks it up.
    res = await askOnce({
      system,
      messages: [...messages, { role: "assistant", content }],
      maxTokens,
    });
    content.push(...res.content);
    inTokens += res.usage?.input_tokens || 0;
    outTokens += res.usage?.output_tokens || 0;
  }

  return { ...res, content, usage: { ...res.usage, input_tokens: inTokens, output_tokens: outTokens } };
}

async function askOnce(args) {
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

/**
 * Since mcp-client-2025-11-20, tool filtering lives on an mcp_toolset entry
 * in `tools`, not on the server definition. The 2025-04-04 revision's
 * `tool_configuration` is rejected.
 *
 * There is deliberately no retry without the filter. The old code did that,
 * and the write tools were silently exposed on every request until someone
 * noticed a warning in the log. If the API rejects this shape, the request
 * fails and explainError says why.
 */
async function sendOnce({ system, messages, maxTokens }) {
  return client.beta.messages.create(
    {
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages,
      mcp_servers: [
        {
          type: "url",
          url: config.nsMcpUrl,
          name: "netsuite",
          authorization_token: config.nsAccessToken,
        },
      ],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: "netsuite",
          // Disabled tools are never offered to the model, so no prompt can
          // talk it into calling them.
          configs: Object.fromEntries(BLOCKED_TOOLS.map((name) => [name, { enabled: false }])),
        },
      ],
    },
    { headers: { "anthropic-beta": config.betaHeader } }
  );
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

/**
 * The answer a chat user should see: the text after the last tool call.
 *
 * Text before that is the model narrating its steps ("Let me check the
 * schema first"). Useful in the terminal trace, noise in a Teams message.
 */
export function answerText(res) {
  const blocks = res.content || [];
  const lastTool = blocks.findLastIndex(
    (b) => b.type === "mcp_tool_use" || b.type === "mcp_tool_result"
  );
  const textOf = (bs) =>
    bs.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();

  // No text after the last tool means the answer was cut off mid-lookup;
  // whatever was said earlier beats an empty message.
  const text = textOf(blocks.slice(lastTool + 1)) || textOf(blocks);

  const stopped = {
    max_tokens: "ran out of room",
    pause_turn: "needed more NetSuite lookups than one answer allows",
  }[res.stop_reason];
  if (stopped && !text) {
    return `I ${stopped} before I could answer. Try a narrower question, for example one year or one location at a time.`;
  }
  if (stopped) {
    return `${text}\n\n(This answer is incomplete: I ${stopped}. Try a narrower question for the rest.)`;
  }
  return text || "NetSuite returned nothing I could turn into an answer. Try rephrasing.";
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
        "  - sendOnce() in src/claude.js uses the mcp_toolset shape, which needs\n" +
        "    MCP_BETA_HEADER=mcp-client-2025-11-20 in .env\n" +
        "  - If the error names mcp_toolset or configs, the shape changed again:\n" +
        "    check the MCP connector page in the Anthropic docs. Do not drop the\n" +
        "    configs to make it work; they keep the write tools blocked"
    );
  } else if (status === 429) {
    console.error("\n429 is a rate limit. Wait and retry.");
  }
}

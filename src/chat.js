/**
 * Stage 2: multi-turn conversation in the terminal.
 *
 *   npm run chat
 *
 * Commands: exit, reset, cost, verbose
 *
 * The key concept: the API is stateless. Every request carries the entire
 * conversation, INCLUDING the mcp_tool_use and mcp_tool_result blocks. Strip
 * those out to save tokens and the model forgets what it looked up, then
 * re-queries or contradicts itself.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadSystemPrompt } from "./prompt.js";
import { askClaude, printResponse, explainError } from "./claude.js";

const messages = [];
let totalIn = 0;
let totalOut = 0;
let verbose = true;

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log("NS Bot. Type a question, or: exit | reset | cost | verbose");

while (true) {
  const q = (await rl.question("\n\x1b[1m> \x1b[0m")).trim();

  if (!q) continue;
  if (q === "exit" || q === "quit") break;

  if (q === "reset") {
    messages.length = 0;
    console.log("(history cleared)");
    continue;
  }
  if (q === "cost") {
    console.log(`Session totals: input=${totalIn} output=${totalOut}`);
    continue;
  }
  if (q === "verbose") {
    verbose = !verbose;
    console.log(`Tool trace ${verbose ? "on" : "off"}`);
    continue;
  }

  messages.push({ role: "user", content: q });

  try {
    // Prompt files are reloaded each turn, so you can edit them in another
    // window and see the effect on the next question.
    const res = await askClaude({ system: loadSystemPrompt(), messages });

    // Push the whole assistant turn. Do not filter the tool blocks out.
    messages.push({ role: "assistant", content: res.content });

    printResponse(res, { verbose });

    totalIn += res.usage?.input_tokens || 0;
    totalOut += res.usage?.output_tokens || 0;

    if (totalIn > 400000) {
      console.log(
        "\n\x1b[33m[warn] Input tokens are climbing. Each turn resends the full\n" +
          "history, and tool results are verbose. Type 'reset' to start fresh.\x1b[0m"
      );
    }
  } catch (err) {
    explainError(err);
    messages.pop(); // drop the failed turn so history stays valid
  }
}

rl.close();
console.log(`\nSession totals: input=${totalIn} output=${totalOut}`);

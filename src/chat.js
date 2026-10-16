/**
 * Stage 2: multi-turn conversation in the terminal.
 *
 *   npm run chat
 *
 * Commands: exit, reset, cost, verbose
 *
 * History, result expiry and the turn limit live in core.js, shared with the
 * Teams bot, so a follow-up behaves the same here as it does in Teams.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ask, reset, freshnessNote } from "./core.js";
import { printResponse, explainError } from "./claude.js";

const CONVERSATION = "terminal";
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
    reset(CONVERSATION);
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

  try {
    const result = await ask(CONVERSATION, q);
    const res = result.response;
    printResponse(res, { verbose });
    const note = freshnessNote(result);
    if (note) console.log(`\x1b[90m[data] ${note}\x1b[0m`);

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
  }
}

rl.close();
console.log(`\nSession totals: input=${totalIn} output=${totalOut}`);
